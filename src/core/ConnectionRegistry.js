/**
 * File: src/core/ConnectionRegistry.js
 * Description: Connection registry that manages WebSocket connections and routes messages to appropriate message queues
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const { EventEmitter } = require("events");
const MessageQueue = require("../utils/MessageQueue");

/**
 * Connection Registry Module
 * Responsible for managing WebSocket connections and message queues
 */
class ConnectionRegistry extends EventEmitter {
    /**
     * @param {Object} logger - Logger instance
     * @param {Function} [onConnectionLostCallback] - Optional callback to invoke when connection is lost after grace period
     * @param {Function} [getCurrentAuthIndex] - Function to get current auth index
     */
    constructor(logger, onConnectionLostCallback = null, getCurrentAuthIndex = null, browserManager = null) {
        super();
        this.logger = logger;
        this.onConnectionLostCallback = onConnectionLostCallback;
        this.getCurrentAuthIndex = getCurrentAuthIndex;
        this.browserManager = browserManager;
        // Map: authIndex -> WebSocket connection
        this.connectionsByAuth = new Map();
        this.messageQueues = new Map();
        // Map: authIndex -> timerId, supports independent grace period for each account
        this.reconnectGraceTimers = new Map();
        // Map: authIndex -> boolean, supports independent reconnect status for each account
        this.reconnectingAccounts = new Map();
    }

    addConnection(websocket, clientInfo) {
        const authIndex = clientInfo.authIndex;

        // Validate authIndex: must be a valid non-negative integer
        if (authIndex === undefined || authIndex < 0 || !Number.isInteger(authIndex)) {
            this.logger.error(
                `[Server] Rejecting connection with invalid authIndex: ${authIndex}. Connection will be closed.`
            );
            try {
                websocket.close(1008, "Invalid authIndex");
            } catch (e) {
                /* ignore */
            }
            return;
        }

        // Check if there's already a connection for this authIndex
        const existingConnection = this.connectionsByAuth.get(authIndex);
        if (existingConnection && existingConnection !== websocket) {
            this.logger.warn(
                `[Server] Duplicate connection detected for authIndex=${authIndex}, closing old connection...`
            );
            try {
                // Remove event listeners to prevent them from firing during close
                existingConnection.removeAllListeners();
                existingConnection.close(1000, "Replaced by new connection");
            } catch (e) {
                this.logger.warn(`[Server] Error closing old connection: ${e.message}`);
            }
        }

        // Clear grace timer for this authIndex
        if (this.reconnectGraceTimers.has(authIndex)) {
            clearTimeout(this.reconnectGraceTimers.get(authIndex));
            this.reconnectGraceTimers.delete(authIndex);
            this.logger.info(`[Server] Grace timer cleared for reconnected authIndex=${authIndex}`);

            // Clear message queues for reconnected current account
            // When WebSocket disconnects, browser aborts all in-flight requests
            // Keeping these queues would cause them to hang until timeout
            const currentAuthIndex = this.getCurrentAuthIndex ? this.getCurrentAuthIndex() : -1;
            if (authIndex === currentAuthIndex && this.messageQueues.size > 0) {
                this.logger.info(
                    `[Server] Reconnected current account #${authIndex}, clearing ${this.messageQueues.size} stale message queues...`
                );
                this.closeAllMessageQueues();
            }
        }

        // Store connection by authIndex
        this.connectionsByAuth.set(authIndex, websocket);
        this.logger.info(
            `[Server] Internal WebSocket client connected (from: ${clientInfo.address}, authIndex: ${authIndex})`
        );

        // Store authIndex on websocket for cleanup
        websocket._authIndex = authIndex;

        websocket.on("message", data => this._handleIncomingMessage(data.toString()));
        websocket.on("close", () => this._removeConnection(websocket));
        websocket.on("error", error =>
            this.logger.error(`[Server] Internal WebSocket connection error: ${error.message}`)
        );
        this.emit("connectionAdded", websocket);
    }

    _removeConnection(websocket) {
        const disconnectedAuthIndex = websocket._authIndex;

        // Remove from connectionsByAuth if it has an authIndex
        if (disconnectedAuthIndex !== undefined && disconnectedAuthIndex >= 0) {
            this.connectionsByAuth.delete(disconnectedAuthIndex);
            this.logger.info(`[Server] Internal WebSocket client disconnected (authIndex: ${disconnectedAuthIndex}).`);
        } else {
            this.logger.info("[Server] Internal WebSocket client disconnected.");
            // Early return for invalid authIndex - no reconnect logic needed
            this.emit("connectionRemoved", websocket);
            return;
        }

        // Check if the page still exists for this account
        // If page is closed/missing, it means the context was intentionally closed, skip reconnect
        if (this.browserManager) {
            const contextData = this.browserManager.contexts.get(disconnectedAuthIndex);
            if (!contextData || !contextData.page || contextData.page.isClosed()) {
                this.logger.info(
                    `[Server] Account #${disconnectedAuthIndex} page is closed/missing, skipping reconnect logic.`
                );
                // Clear any existing grace timer
                if (this.reconnectGraceTimers.has(disconnectedAuthIndex)) {
                    clearTimeout(this.reconnectGraceTimers.get(disconnectedAuthIndex));
                    this.reconnectGraceTimers.delete(disconnectedAuthIndex);
                }
                this.emit("connectionRemoved", websocket);
                return;
            }
        }

        // Clear any existing grace timer for THIS account before starting a new one
        if (this.reconnectGraceTimers.has(disconnectedAuthIndex)) {
            clearTimeout(this.reconnectGraceTimers.get(disconnectedAuthIndex));
        }

        this.logger.info(`[Server] Starting 5-second reconnect grace period for account #${disconnectedAuthIndex}...`);
        const graceTimerId = setTimeout(async () => {
            this.logger.info(
                `[Server] Grace period ended for account #${disconnectedAuthIndex}, no reconnection detected.`
            );

            // Re-check if this is the current account at the time of grace period expiry
            const currentAuthIndex = this.getCurrentAuthIndex ? this.getCurrentAuthIndex() : -1;
            const isCurrentAccount = disconnectedAuthIndex === currentAuthIndex;

            // Only clear message queues if this is the current account
            if (isCurrentAccount) {
                this.closeAllMessageQueues();
            } else {
                this.logger.info(
                    `[Server] Non-current account #${disconnectedAuthIndex} disconnected, keeping message queues intact.`
                );
            }

            // Attempt lightweight reconnect if callback is provided and this account is not already reconnecting
            const isAccountReconnecting = this.reconnectingAccounts.get(disconnectedAuthIndex) || false;
            if (this.onConnectionLostCallback && !isAccountReconnecting) {
                this.reconnectingAccounts.set(disconnectedAuthIndex, true);
                const lightweightReconnectTimeoutMs = 55000;
                this.logger.info(
                    `[Server] Attempting lightweight reconnect for account #${disconnectedAuthIndex} (timeout ${lightweightReconnectTimeoutMs / 1000}s)...`
                );
                let timeoutId;
                try {
                    const callbackPromise = this.onConnectionLostCallback(disconnectedAuthIndex);
                    const timeoutPromise = new Promise((_, reject) => {
                        timeoutId = setTimeout(
                            () => reject(new Error("Lightweight reconnect timed out")),
                            lightweightReconnectTimeoutMs
                        );
                    });
                    await Promise.race([callbackPromise, timeoutPromise]);
                    this.logger.info(
                        `[Server] Lightweight reconnect callback completed for account #${disconnectedAuthIndex}.`
                    );
                } catch (error) {
                    this.logger.error(
                        `[Server] Lightweight reconnect failed for account #${disconnectedAuthIndex}: ${error.message}`
                    );
                } finally {
                    if (timeoutId) {
                        clearTimeout(timeoutId);
                    }
                    this.reconnectingAccounts.delete(disconnectedAuthIndex);
                }
            }

            this.emit("connectionLost");

            this.reconnectGraceTimers.delete(disconnectedAuthIndex);
        }, 5000);

        if (disconnectedAuthIndex !== undefined && disconnectedAuthIndex >= 0) {
            this.reconnectGraceTimers.set(disconnectedAuthIndex, graceTimerId);
        }

        this.emit("connectionRemoved", websocket);
    }

    _handleIncomingMessage(messageData) {
        try {
            const parsedMessage = JSON.parse(messageData);
            const requestId = parsedMessage.request_id;
            if (!requestId) {
                this.logger.warn("[Server] Received invalid message: missing request_id");
                return;
            }
            const queue = this.messageQueues.get(requestId);
            if (queue) {
                this._routeMessage(parsedMessage, queue);
            } else {
                this.logger.warn(`[Server] Received message for unknown or outdated request ID: ${requestId}`);
            }
        } catch (error) {
            this.logger.error("[Server] Failed to parse internal WebSocket message");
        }
    }

    _routeMessage(message, queue) {
        const { event_type } = message;
        switch (event_type) {
            case "response_headers":
            case "chunk":
            case "error":
                queue.enqueue(message);
                break;
            case "stream_close":
                queue.enqueue({ type: "STREAM_END" });
                break;
            default:
                this.logger.warn(`[Server] Unknown internal event type: ${event_type}`);
        }
    }

    isReconnectingInProgress() {
        // Check if any account is currently reconnecting
        return this.reconnectingAccounts.size > 0;
    }

    isInGracePeriod() {
        // Only check if current account is in grace period, to avoid non-current account disconnection affecting current account's request handling
        const currentAuthIndex = this.getCurrentAuthIndex ? this.getCurrentAuthIndex() : -1;
        return currentAuthIndex >= 0 && this.reconnectGraceTimers.has(currentAuthIndex);
    }

    getConnectionByAuth(authIndex) {
        const connection = this.connectionsByAuth.get(authIndex);
        if (connection) {
            this.logger.debug(`[Registry] Found WebSocket connection for authIndex=${authIndex}`);
        } else {
            this.logger.debug(
                `[Registry] No WebSocket connection found for authIndex=${authIndex}. Available: [${Array.from(this.connectionsByAuth.keys()).join(", ")}]`
            );
        }
        return connection;
    }

    /**
     * Close WebSocket connection for a specific account
     * @param {number} authIndex - The auth index to close connection for
     */
    closeConnectionByAuth(authIndex) {
        const connection = this.connectionsByAuth.get(authIndex);
        if (connection) {
            this.logger.info(`[Registry] Closing WebSocket connection for authIndex=${authIndex}`);
            try {
                connection.close();
            } catch (e) {
                this.logger.warn(`[Registry] Error closing WebSocket for authIndex=${authIndex}: ${e.message}`);
            }
            // Remove from map immediately (the close event will also trigger _removeConnection)
            this.connectionsByAuth.delete(authIndex);

            // Clear any grace timers for this account
            if (this.reconnectGraceTimers.has(authIndex)) {
                clearTimeout(this.reconnectGraceTimers.get(authIndex));
                this.reconnectGraceTimers.delete(authIndex);
            }
        } else {
            this.logger.debug(`[Registry] No WebSocket connection to close for authIndex=${authIndex}`);
        }
    }

    createMessageQueue(requestId) {
        const queue = new MessageQueue();
        this.messageQueues.set(requestId, queue);
        return queue;
    }

    removeMessageQueue(requestId) {
        const queue = this.messageQueues.get(requestId);
        if (queue) {
            queue.close();
            this.messageQueues.delete(requestId);
        }
    }

    /**
     * Force close all message queues
     * Used when the active account is deleted/reset and we want to terminate all pending requests immediately
     */
    closeAllMessageQueues() {
        if (this.messageQueues.size > 0) {
            this.logger.info(`[Registry] Force closing ${this.messageQueues.size} pending message queues...`);
            this.messageQueues.forEach(queue => {
                try {
                    queue.close();
                } catch (e) {
                    /* ignore */
                }
            });
            this.messageQueues.clear();
        }
    }
}

module.exports = ConnectionRegistry;
