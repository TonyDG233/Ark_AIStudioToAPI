/**
 * File: src/core/RequestHandler/RetryHandler.js
 * Description: Immediate status retries and queued request retry execution.
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const ConnectionHandler = require("./ConnectionHandler");
const { isUserAbortedError } = require("../../utils/CustomErrors");
const { QueueTimeoutError } = require("../../utils/MessageQueue");

class RetryHandler extends ConnectionHandler {
    /**
     * Start recursively scheduled SSE keep-alive writes.
     * @param {object} res
     * @param {string} frame
     * @param {() => void} initializeResponse
     * @param {(timer: any) => void} updateTimer
     */
    _startSseKeepAlive(res, frame, initializeResponse, updateTimer) {
        const scheduleNextKeepAlive = () => {
            const randomInterval = 12000 + Math.floor(Math.random() * 6000);
            const timer = setTimeout(() => {
                if (!res.headersSent) initializeResponse();
                if (!res.writableEnded) {
                    res.write(frame);
                    scheduleNextKeepAlive();
                }
            }, randomInterval);
            updateTimer(timer);
        };

        scheduleNextKeepAlive();
    }

    _prepareGenerationProxyRequest({ googleBody, isStreaming, model, modelStreamingMode, requestId, res }) {
        const effectiveStreamMode = modelStreamingMode || this.config.streamingMode;
        const useRealStream = isStreaming && effectiveStreamMode === "real";
        const streamMode = useRealStream ? "real" : "fake";
        const googleEndpoint = useRealStream ? "streamGenerateContent" : "generateContent";
        const proxyRequest = {
            body: JSON.stringify(googleBody),
            headers: { "Content-Type": "application/json" },
            is_generative: true,
            method: "POST",
            path: `/v1beta/models/${model}:${googleEndpoint}`,
            query_params: useRealStream ? { alt: "sse" } : {},
            request_id: requestId,
            streaming_mode: streamMode,
        };

        this._initializeProxyRequestAttempt(proxyRequest);
        res.__proxyResponseStreamMode = isStreaming ? streamMode : null;
        this._updateTrackedRequest(requestId, {
            isStreaming,
            model,
            path: proxyRequest.path,
            requestCategory: "generation",
            ...(isStreaming ? { streamMode } : {}),
        });

        return { proxyRequest, useRealStream };
    }

    _dispatchProxyRequestForFirstMessage(proxyRequest, requestId, res) {
        const messageQueue = this.connectionRegistry.createMessageQueue(
            requestId,
            this.currentAuthIndex,
            proxyRequest.request_attempt_id
        );
        const messageQueueAuthIndex =
            this.connectionRegistry.getAuthIndexForRequest(requestId) ?? this.currentAuthIndex;
        this._setupClientDisconnectHandler(res, requestId);

        this._getUsageStatsService()?.recordAttempt(
            requestId,
            messageQueueAuthIndex,
            this._getAccountNameForIndex(messageQueueAuthIndex)
        );
        this._forwardRequest(proxyRequest, messageQueueAuthIndex);

        return {
            firstMessage: messageQueue.dequeue(),
            messageQueue,
        };
    }

    _createImmediateSwitchTracker(initialAuthIndex = this.currentAuthIndex) {
        const attemptedAuthIndices = new Set();
        if (Number.isInteger(initialAuthIndex) && initialAuthIndex >= 0) {
            attemptedAuthIndices.add(initialAuthIndex);
        }
        return { attemptedAuthIndices };
    }

    _getImmediateStatusRetryCloseReason(status) {
        return `immediate_status_retry_${status}`;
    }

    async _prepareRealStreamImmediateRetry(
        proxyRequest,
        currentQueue,
        errorDetails,
        immediateSwitchTracker,
        currentQueueAuthIndex
    ) {
        this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);

        const retryPrepared = await this._prepareImmediateStatusRetry(
            errorDetails,
            proxyRequest.request_id,
            immediateSwitchTracker,
            currentQueueAuthIndex
        );
        if (!retryPrepared) return null;

        const errorStatus = Number(errorDetails?.status);
        try {
            currentQueue.close(this._getImmediateStatusRetryCloseReason(errorStatus));
        } catch {
            /* empty */
        }

        this._advanceProxyRequestAttempt(proxyRequest);
        const nextQueueAuthIndex = this.currentAuthIndex;
        const nextQueue = this.connectionRegistry.createMessageQueue(
            proxyRequest.request_id,
            nextQueueAuthIndex,
            proxyRequest.request_attempt_id
        );

        return {
            currentQueue: nextQueue,
            currentQueueAuthIndex: nextQueueAuthIndex,
        };
    }

    async _performImmediateSwitchRetry(errorDetails, requestId, tracker) {
        await this.authSwitcher.handleRequestFailureAndSwitch(
            { message: errorDetails.message, status: Number(errorDetails.status) },
            null
        );

        const ready = await this._waitForSystemAndConnectionIfBusy(null, {
            sendError: () => {},
        });
        if (!ready) {
            throw new Error("System not ready after immediate-switch retry.");
        }

        const newAuthIndex = this.currentAuthIndex;
        if (!Number.isInteger(newAuthIndex) || newAuthIndex < 0) {
            this.logger.warn(
                `[Request] Immediate switch for request #${requestId} did not produce a valid target account.`
            );
            return false;
        }

        if (tracker.attemptedAuthIndices.has(newAuthIndex)) {
            this.logger.warn(
                `[Request] Immediate switch for request #${requestId} returned to already-attempted account #${newAuthIndex}, stopping account-switch retries.`
            );
            return false;
        }

        tracker.attemptedAuthIndices.add(newAuthIndex);
        return true;
    }

    async _prepareImmediateStatusRetry(errorDetails, requestId, tracker, sourceAuthIndex) {
        const currentAuthIndex = this.currentAuthIndex;
        const hasSourceAuth = Number.isInteger(sourceAuthIndex) && sourceAuthIndex >= 0;
        const hasCurrentAuth = Number.isInteger(currentAuthIndex) && currentAuthIndex >= 0;

        if (hasSourceAuth && hasCurrentAuth && sourceAuthIndex !== currentAuthIndex) {
            const ready = await this._waitForSystemAndConnectionIfBusy(null, {
                sendError: () => {},
            });
            if (!ready) {
                throw new Error(
                    `System not ready after non-current account retry preparation for request #${requestId}: ` +
                        `status=${errorDetails.status}, sourceAuthIndex=${sourceAuthIndex}, currentAuthIndex=${currentAuthIndex}.`
                );
            }

            const retryAuthIndex = this.currentAuthIndex;
            if (sourceAuthIndex === retryAuthIndex) {
                return this._performImmediateSwitchRetry(errorDetails, requestId, tracker);
            }
            if (!Number.isInteger(retryAuthIndex) || retryAuthIndex < 0) {
                this.logger.warn(
                    `[Request] Non-current account retry for request #${requestId} did not find a valid current account ` +
                        `(status=${errorDetails.status}, sourceAuthIndex=${sourceAuthIndex}, retryAuthIndex=${retryAuthIndex}).`
                );
                return false;
            }
            if (tracker.attemptedAuthIndices.has(retryAuthIndex)) {
                this.logger.warn(
                    `[Request] Non-current account retry for request #${requestId} would reuse already-attempted account #${retryAuthIndex} ` +
                        `(status=${errorDetails.status}, sourceAuthIndex=${sourceAuthIndex}), stopping account-switch retries.`
                );
                return false;
            }

            this.logger.warn(
                `[Request] Received ${errorDetails.status} from non-current account #${sourceAuthIndex}; ` +
                    `retrying request #${requestId} on current account #${retryAuthIndex} without switching.`
            );

            tracker.attemptedAuthIndices.add(retryAuthIndex);
            return true;
        }

        return this._performImmediateSwitchRetry(errorDetails, requestId, tracker);
    }

    _logFinalRequestFailure(errorDetails, contextLabel = "Request", requestId = null, options = {}) {
        const requestIdSuffix = requestId ? `, request ID: ${requestId}` : "";
        const failurePhase = options.afterRetries === false ? "failed" : "failed after retries";
        this.logger.error(
            `❌ [Request] ${contextLabel} ${failurePhase}. Status code: ${errorDetails?.status || 500}, message: ${errorDetails?.message || "Unknown error"}${requestIdSuffix}`
        );
    }

    /**
     * Handle the final account-switch decision after a request failure.
     * @param {object} errorDetails
     * @param {{connectionResetContext?: string | null, skipAccountSwitch?: unknown}} [options]
     * @returns {Promise<unknown> | null}
     */
    _handleFinalFailureAccountSwitch(
        errorDetails,
        { connectionResetContext = null, skipAccountSwitch = errorDetails?.skipAccountSwitch } = {}
    ) {
        if (!skipAccountSwitch && !this._isConnectionResetError(errorDetails)) {
            return this.authSwitcher.handleRequestFailureAndSwitch(errorDetails, null);
        } else if (skipAccountSwitch) {
            this.logger.info("[Request] Immediate-switch retries exhausted, skipping additional account switch.");
        } else if (connectionResetContext) {
            this.logger.info(
                `[Request] Failure due to connection reset (${connectionResetContext}), skipping account switch.`
            );
        }

        return null;
    }

    async _executeRequestWithRetries(proxyRequest, messageQueue) {
        let lastError = null;
        let currentQueue = messageQueue;
        const registeredQueueAuthIndex = this.connectionRegistry.getAuthIndexForRequest(proxyRequest.request_id);
        // Track the authIndex registered for the current queue, which may differ from the global current account.
        let currentQueueAuthIndex =
            Number.isInteger(registeredQueueAuthIndex) && registeredQueueAuthIndex >= 0
                ? registeredQueueAuthIndex
                : this.currentAuthIndex;
        let retryAttempt = 1;
        const immediateSwitchTracker = this._createImmediateSwitchTracker(currentQueueAuthIndex);

        while (retryAttempt <= this.config.maxRetries) {
            // Record attempt at the start of each retry, before forwarding.
            // This ensures failed attempts (e.g. 429 before any response) are also counted.
            this._getUsageStatsService()?.recordAttempt(
                proxyRequest.request_id,
                currentQueueAuthIndex,
                this._getAccountNameForIndex(currentQueueAuthIndex)
            );
            try {
                this._forwardRequest(proxyRequest, currentQueueAuthIndex);

                const initialMessage = await currentQueue.dequeue(this.timeouts.FAKE_STREAM);

                if (initialMessage.event_type === "timeout") {
                    throw new Error(
                        JSON.stringify({
                            event_type: "error",
                            message: "Request timed out waiting for browser response.",
                            status: 504,
                        })
                    );
                }

                if (initialMessage.event_type === "error") {
                    // Throw a structured error to be caught by the catch block
                    throw new Error(JSON.stringify(initialMessage));
                }

                // Success, return the initial message and the queue that received it
                return { message: initialMessage, queue: currentQueue, success: true };
            } catch (error) {
                // Parse the structured error message
                let errorPayload;
                try {
                    errorPayload = JSON.parse(error.message);
                } catch (e) {
                    // JSON parse failed - check if it's a timeout error
                    if (error.code === "QUEUE_TIMEOUT" || error instanceof QueueTimeoutError) {
                        errorPayload = { message: error.message || "Queue timeout", status: 504 };
                    } else {
                        errorPayload = { message: error.message, status: 500 };
                    }
                }

                // Stop retrying immediately if the queue is closed
                if (this._isConnectionResetError(error)) {
                    // Check the actual closure reason to provide accurate error messages
                    const reason = error.reason || "unknown";
                    const isClientDisconnect = reason === "client_disconnect";
                    const currentAuthIndex = this.currentAuthIndex;
                    const isClosedAccountRetryable = reason === "context_closed" || reason === "page_closed";
                    const canRetryOnCurrentAccountCandidate =
                        !isClientDisconnect &&
                        isClosedAccountRetryable &&
                        retryAttempt < this.config.maxRetries &&
                        Number.isInteger(currentQueueAuthIndex) &&
                        currentQueueAuthIndex >= 0 &&
                        Number.isInteger(currentAuthIndex) &&
                        currentAuthIndex >= 0 &&
                        currentQueueAuthIndex !== currentAuthIndex;

                    if (canRetryOnCurrentAccountCandidate) {
                        const ready = await this._waitForSystemAndConnectionIfBusy(null, {
                            connectionMessage: "Service temporarily unavailable: Connection not ready before retry.",
                        });
                        if (!ready) {
                            lastError = {
                                message: `WebSocket connection not ready before retry on account #${this.currentAuthIndex}.`,
                                status: 503,
                            };
                            break;
                        }
                    }

                    const canRetryOnCurrentAccount =
                        canRetryOnCurrentAccountCandidate &&
                        Boolean(this.connectionRegistry.getConnectionByAuth(currentAuthIndex, false));

                    if (isClientDisconnect) {
                        this.logger.warn(`[Request] Message queue closed due to client disconnect, aborting retries.`);
                        lastError = { message: "Connection lost (client disconnect)", status: 503 };
                    } else if (canRetryOnCurrentAccount) {
                        this.logger.warn(
                            `[Request] Message queue for non-current account #${currentQueueAuthIndex} closed ` +
                                `(reason: ${reason}); retrying request #${proxyRequest.request_id} on current account #${currentAuthIndex}.`
                        );
                        lastError = {
                            message: `Queue closed: ${error.message || reason}`,
                            reason,
                            status: 503,
                        };
                        this._advanceProxyRequestAttempt(proxyRequest);
                        currentQueue = this.connectionRegistry.createMessageQueue(
                            proxyRequest.request_id,
                            currentAuthIndex,
                            proxyRequest.request_attempt_id
                        );
                        currentQueueAuthIndex = currentAuthIndex;
                        if (Number.isInteger(currentQueueAuthIndex) && currentQueueAuthIndex >= 0) {
                            immediateSwitchTracker.attemptedAuthIndices.add(currentQueueAuthIndex);
                        }
                        await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
                        retryAttempt++;
                        continue;
                    } else {
                        // Queue closed for other reasons (account_switch, system_reset, etc.)
                        this.logger.warn(`[Request] Message queue closed (reason: ${reason}), aborting retries.`);
                        lastError = {
                            message: `Queue closed: ${error.message || reason}`,
                            reason,
                            status: 503,
                        };
                    }
                    break;
                }

                lastError = errorPayload;
                this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);

                const errorStatus = Number(errorPayload?.status);
                const isNonRetryableEmbeddingClientError =
                    (errorStatus === 400 || errorStatus === 404) &&
                    this._categorizeRequest(proxyRequest?.path, "request") === "embedding";
                if (isNonRetryableEmbeddingClientError) {
                    lastError = { ...errorPayload, skipAccountSwitch: true };
                    this.logger.warn(
                        `[Request] Embedding request failed with non-retryable status ${errorPayload.status}; skipping retries and account switching.`
                    );
                    break;
                }

                // Check if we should stop retrying immediately based on status code
                if (
                    Number.isFinite(errorStatus) &&
                    this.config?.immediateSwitchStatusCodes?.includes(errorStatus) &&
                    !isUserAbortedError(errorPayload)
                ) {
                    this.logger.warn(`[Request] Received ${errorStatus}, preparing retry...`);
                    try {
                        const retryPrepared = await this._prepareImmediateStatusRetry(
                            errorPayload,
                            proxyRequest.request_id,
                            immediateSwitchTracker,
                            currentQueueAuthIndex
                        );
                        if (!retryPrepared) {
                            lastError = { ...errorPayload, skipAccountSwitch: true };
                            break;
                        }
                    } catch (switchError) {
                        lastError = { ...errorPayload, skipAccountSwitch: true };
                        this.logger.error(
                            `❌ [Request] Account switch failed during immediate-switch retry flow: ${switchError.message}`
                        );
                        break;
                    }

                    try {
                        currentQueue.close("retry_creating_new_queue");
                    } catch (e) {
                        this.logger.debug(`[Request] Failed to close old queue before retry: ${e.message}`);
                    }

                    this.logger.debug(
                        `[Request] Creating new message queue after immediate switch for request #${proxyRequest.request_id} (switching from account #${currentQueueAuthIndex} to #${this.currentAuthIndex})`
                    );
                    this._advanceProxyRequestAttempt(proxyRequest);
                    currentQueue = this.connectionRegistry.createMessageQueue(
                        proxyRequest.request_id,
                        this.currentAuthIndex,
                        proxyRequest.request_attempt_id
                    );
                    currentQueueAuthIndex = this.currentAuthIndex;
                    continue;
                }

                // Log the warning for the current attempt
                this.logger.warn(
                    `[Request] Attempt #${retryAttempt}/${this.config.maxRetries} for request #${proxyRequest.request_id} failed: ${errorPayload.message}`
                );

                // If it's the last attempt, break the loop to return failure
                if (retryAttempt >= this.config.maxRetries) {
                    this.logger.error(
                        `❌ [Request] All ${this.config.maxRetries} retries failed for request #${proxyRequest.request_id}. Final error: ${errorPayload.message}`
                    );
                    break;
                }

                // Explicitly close the old queue before creating a new one
                // This ensures waitingResolvers are properly rejected even if authIndex changed
                try {
                    currentQueue.close("retry_creating_new_queue");
                } catch (e) {
                    this.logger.debug(`[Request] Failed to close old queue before retry: ${e.message}`);
                }

                // Create a new message queue for the retry with CURRENT account
                // Note: We keep the same requestId so the browser response routes to the new queue
                // createMessageQueue will automatically close and remove any existing queue with the same ID from the registry
                this.logger.debug(
                    `[Request] Creating new message queue for retry #${retryAttempt + 1} for request #${proxyRequest.request_id} (switching from account #${currentQueueAuthIndex} to #${this.currentAuthIndex})`
                );
                this._advanceProxyRequestAttempt(proxyRequest);
                currentQueue = this.connectionRegistry.createMessageQueue(
                    proxyRequest.request_id,
                    this.currentAuthIndex,
                    proxyRequest.request_attempt_id
                );
                // Update tracked authIndex for the new queue
                currentQueueAuthIndex = this.currentAuthIndex;
                if (Number.isInteger(currentQueueAuthIndex) && currentQueueAuthIndex >= 0) {
                    immediateSwitchTracker.attemptedAuthIndices.add(currentQueueAuthIndex);
                }

                // Wait before the next retry
                await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
                if (
                    !(await this._waitForSystemAndConnectionIfBusy(null, {
                        connectionMessage: "Service temporarily unavailable: Connection not ready before retry.",
                    }))
                ) {
                    lastError = {
                        message: `WebSocket connection not ready before retry on account #${this.currentAuthIndex}.`,
                        status: 503,
                    };
                    break;
                }
                retryAttempt++;
            }
        }

        // After all retries, return the final failure result
        return { error: lastError, success: false };
    }
}

module.exports = RetryHandler;
