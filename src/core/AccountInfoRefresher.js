/**
 * File: src/core/AccountInfoRefresher.js
 * Description: Node-only account info refresher. Re-validates stored auth cookies and
 * backfills email / benefit tier without opening a browser.
 *
 * Transport (verified live on 2026-10-17 against a free and a Pro account):
 * - POST https://alkalimakersuite-pa.clients6.google.com/$rpc/.../GetAiStudioBenefitTier
 *   with body "[]", content-type "application/json+protobuf", the account's Google
 *   cookies, a locally computed SAPISIDHASH authorization header and the AI Studio
 *   web API key (default baked in below, env override MAKERSUITE_WEB_API_KEY).
 * - SAPISIDHASH header: three space-joined segments
 *   "<SCHEME> <ts>_<sha1hex(`${ts} ${cookieValue} ${origin}`)>" for
 *   SAPISIDHASH/SAPISID, SAPISID1PHASH/__Secure-1PAPISID, SAPISID3PHASH/__Secure-3PAPISID,
 *   with origin = https://aistudio.google.com (the page origin).
 * - Response: 200 => credentials valid; empty array => tier 0 (free); [n] => tier enum
 *   (1=pro, 2=ultra, 3=plus per client bundle). 401 => invalid credentials.
 *   403 with API_KEY_SERVICE_BLOCKED => key problem (re-extract from page HTML once).
 * - Email: extracted from the app page HTML with the same session cookies; this matches
 *   the accountName stored by the VNC auth saving flow.
 *
 * Author: TonyDG (account info refresh)
 */

const crypto = require("crypto");
const http = require("http");
const https = require("https");
const tls = require("tls");
const { parseProxyFromEnv } = require("../utils/ProxyUtils");

const RPC_HOST = "alkalimakersuite-pa.clients6.google.com";
const RPC_BASE = "/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/";
const PAGE_HOST = "aistudio.google.com";
const ORIGIN = "https://aistudio.google.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";
const TIER_BY_CODE = { 1: "pro", 2: "ultra", 3: "plus" };
const DEFAULT_WEB_API_KEY = "AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// Account checks are network-bound; a small worker pool keeps wall time down while
// staying gentle on the upstream (each worker holds at most one request in flight).
const REFRESH_CONCURRENCY = 3;

const sha1hex = value => crypto.createHash("sha1").update(value, "utf8").digest("hex");

const maskEmail = email => {
    const text = String(email || "");
    const at = text.indexOf("@");
    return at > 1 ? `${text.slice(0, 2)}***${text.slice(at)}` : `${text.slice(0, 2)}***`;
};

class AccountInfoRefresher {
    constructor(logger, config, authSource) {
        this.logger = logger;
        this.config = config;
        this.authSource = authSource;
        const override = typeof config.makerSuiteWebApiKey === "string" ? config.makerSuiteWebApiKey.trim() : "";
        this.webApiKey = override || DEFAULT_WEB_API_KEY;
        this._activeRun = false;
    }

    isRefreshing() {
        return this._activeRun;
    }

    /**
     * Refresh a batch of accounts with a small worker pool (order of results matches input).
     * @param {number[]} indices - Auth indices to refresh
     * @param {object} [options] - { refreshEmail: boolean } force email re-extraction
     * @returns {Promise<Array<object>>} Per-account results
     */
    async refreshAccounts(indices, options = {}) {
        if (this._activeRun) {
            throw new Error("An account info refresh run is already in progress.");
        }
        this._activeRun = true;
        const results = new Array(indices.length);
        let cursor = 0;
        const workerCount = Math.max(1, Math.min(REFRESH_CONCURRENCY, indices.length));
        try {
            const workers = [];
            for (let worker = 0; worker < workerCount; worker++) {
                workers.push(
                    (async () => {
                        while (cursor < indices.length) {
                            const slot = cursor++;
                            const index = indices[slot];
                            try {
                                results[slot] = await this.refreshAccount(index, options);
                            } catch (error) {
                                results[slot] = {
                                    checkedAt: null,
                                    error: error.message || String(error),
                                    index,
                                    tier: null,
                                    valid: null,
                                };
                            }
                        }
                    })()
                );
            }
            await Promise.all(workers);
        } finally {
            this._activeRun = false;
        }
        return results;
    }

    /**
     * Refresh one account: credential validity + benefit tier (+ optional email backfill).
     * @param {number} index - Auth index
     * @param {object} [options] - { refreshEmail: boolean }
     */
    async refreshAccount(index, options = {}) {
        if (!Number.isInteger(index)) {
            throw new Error("Invalid account index.");
        }
        const authData = this.authSource.getAuth(index);
        if (!authData) {
            throw new Error(`Auth file auth-${index}.json is missing or unreadable.`);
        }

        const cookies = this._collectCookies(authData);
        const checkedAt = new Date().toISOString();
        const result = { checkedAt, email: authData.accountName || null, index, tier: null, valid: false };
        const wasExpired = this.authSource.isExpired(index);

        const response = await this._postTierRequest(cookies);
        const envelope = this._parseEnvelope(response.body);
        const message = this._envelopeMessage(envelope);

        if (response.status === 200) {
            const tierCode = this._tierCodeFromEnvelope(envelope);
            result.valid = true;
            result.tier = this._tierName(tierCode);
            const patch = { benefitTier: result.tier, tierCheckedAt: checkedAt };

            const wantsEmail = options.refreshEmail === true || !authData.accountName;
            if (wantsEmail) {
                try {
                    const email = await this._fetchAccountEmail(cookies, authData.accountName);
                    if (email) {
                        result.email = email;
                        patch.accountName = email;
                    }
                } catch (error) {
                    result.emailError = error.message || String(error);
                }
            }

            await this.authSource.updateAccountMetadata(index, patch);
            if (wasExpired) {
                await this.authSource.unmarkAsExpired(index);
            }
            this.logger.info(
                `[Refresh] #${index} valid, tier=${result.tier}${result.email ? `, email=${maskEmail(result.email)}` : ""}`
            );
            return result;
        }

        result.error = `HTTP ${response.status}${message ? `: ${message}` : ""}`;
        if (response.status === 401) {
            result.valid = false;
            await this.authSource.markAsExpired(index);
            this.logger.warn(`[Refresh] #${index} credentials invalid (401), marked as expired.`);
            return result;
        }

        // Non-authoritative failures (region blocks, key trouble, transient upstream
        // errors) never change auth state; report them as-is.
        result.valid = null;
        this.logger.warn(`[Refresh] #${index} check failed: ${result.error}`);
        return result;
    }

    _collectCookies(authData) {
        const now = Math.floor(Date.now() / 1000);
        const cookies = (authData.cookies || []).filter(
            cookie =>
                /(^|\.)google\.com$/i.test(cookie.domain || "") &&
                (!cookie.expires || cookie.expires < 0 || cookie.expires > now)
        );
        const jar = {};
        for (const cookie of cookies) {
            jar[cookie.name] = cookie.value;
        }
        return { header: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; "), jar };
    }

    _buildAuthorization(jar) {
        const ts = Math.floor(Date.now() / 1000);
        const part = value => `${ts}_${sha1hex(`${ts} ${value} ${ORIGIN}`)}`;
        const segments = [];
        if (jar["SAPISID"]) {
            segments.push(`SAPISIDHASH ${part(jar["SAPISID"])}`);
        }
        if (jar["__Secure-1PAPISID"]) {
            segments.push(`SAPISID1PHASH ${part(jar["__Secure-1PAPISID"])}`);
        }
        if (jar["__Secure-3PAPISID"]) {
            segments.push(`SAPISID3PHASH ${part(jar["__Secure-3PAPISID"])}`);
        }
        return segments.join(" ");
    }

    _rpcHeaders(cookies) {
        const headers = {
            accept: "*/*",
            "content-type": "application/json+protobuf",
            origin: ORIGIN,
            referer: `${ORIGIN}/`,
            "user-agent": USER_AGENT,
            "x-goog-api-key": this.webApiKey,
            "x-goog-authuser": "0",
            "x-user-agent": "grpc-web-javascript/0.1",
        };
        if (cookies.header) {
            headers.cookie = cookies.header;
        }
        const authorization = this._buildAuthorization(cookies.jar);
        if (authorization) {
            headers.authorization = authorization;
        }
        return headers;
    }

    async _postTierRequest(cookies) {
        const requestOptions = {
            body: "[]",
            headers: this._rpcHeaders(cookies),
            method: "POST",
            pathSuffix: `${RPC_BASE}GetAiStudioBenefitTier`,
            targetHost: RPC_HOST,
        };
        let response = await this._requestViaProxy(requestOptions);
        if (response.status === 403 && this._isKeyProblem(response.body)) {
            const rotatedKey = await this._recoverWebApiKey(cookies);
            if (rotatedKey && rotatedKey !== this.webApiKey) {
                this.logger.warn("[Refresh] Web API key was rejected; retrying with a re-extracted key.");
                requestOptions.headers["x-goog-api-key"] = rotatedKey;
                response = await this._requestViaProxy(requestOptions);
            }
        }
        return response;
    }

    _isKeyProblem(body) {
        const text = String(body || "");
        return text.includes("API_KEY_SERVICE_BLOCKED") || text.includes("unregistered callers");
    }

    async _recoverWebApiKey(cookies) {
        try {
            const html = await this._fetchAppHtml(cookies);
            const keys = Array.from(new Set(html.match(/AIzaSy[A-Za-z0-9_-]{25,45}/g) || []));
            const key = keys.find(candidate => candidate.startsWith("AIzaSyDdP8")) || keys[0] || null;
            if (key) {
                this.webApiKey = key;
            }
            return key;
        } catch (error) {
            this.logger.warn(`[Refresh] Unable to re-extract the web API key: ${error.message || error}`);
            return null;
        }
    }

    _parseEnvelope(body) {
        try {
            const parsed = JSON.parse(String(body || "").trim());
            return Array.isArray(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }

    _tierCodeFromEnvelope(envelope) {
        if (!Array.isArray(envelope) || envelope.length === 0) {
            return 0;
        }
        return typeof envelope[0] === "number" ? envelope[0] : 0;
    }

    _tierName(code) {
        return TIER_BY_CODE[code] || (code === 0 ? "free" : `unknown-${code}`);
    }

    _envelopeMessage(envelope) {
        if (Array.isArray(envelope) && typeof envelope[1] === "string") {
            return envelope[1].slice(0, 300);
        }
        return "";
    }

    _appIdFromConfig() {
        const url = typeof this.config.aiStudioAppUrl === "string" ? this.config.aiStudioAppUrl : "";
        const match = url.match(/\/apps\/([A-Za-z0-9-]+)/);
        return match ? match[1] : null;
    }

    async _fetchAppHtml(cookies) {
        const appId = this._appIdFromConfig();
        if (!appId) {
            throw new Error("aiStudioAppUrl does not contain an app id; cannot fetch the page.");
        }
        const response = await this._requestViaProxy({
            body: "",
            headers: {
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "user-agent": USER_AGENT,
                ...(cookies.header ? { cookie: cookies.header } : {}),
            },
            method: "GET",
            pathSuffix: `/apps/${appId}`,
            targetHost: PAGE_HOST,
        });
        if (response.status !== 200) {
            throw new Error(`page fetch HTTP ${response.status}`);
        }
        return response.body;
    }

    async _fetchAccountEmail(cookies, existingName) {
        const html = await this._fetchAppHtml(cookies);
        // WIZ_global_data carries the signed-in account email in the "oPEP7c" config field.
        const configMatch = html.match(/"oPEP7c":"([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})"/);
        if (configMatch) {
            return configMatch[1];
        }
        const found = Array.from(new Set(html.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [])).filter(
            email =>
                !/@(?:example\.(?:com|org)|schema\.org|w3\.org|google\.com|gstatic\.com|googleusercontent\.com)$/i.test(
                    email
                )
        );
        if (found.length === 0) {
            return null;
        }
        if (existingName) {
            const exact = found.find(email => email.toLowerCase() === String(existingName).toLowerCase());
            if (exact) {
                return exact;
            }
        }
        return found[0];
    }

    /**
     * Minimal HTTPS request over an HTTP CONNECT tunnel (no external dependencies).
     * Falls back to a direct TLS request when no proxy is configured.
     */
    _requestViaProxy({ body, headers, method, pathSuffix, targetHost, timeoutMs = 30000 }) {
        const proxy = parseProxyFromEnv();
        if (!proxy) {
            return this._directRequest({ body, headers, method, pathSuffix, targetHost, timeoutMs });
        }
        return new Promise((resolve, reject) => {
            let proxyUrl;
            try {
                const raw = proxy.server.includes("://") ? proxy.server : `http://${proxy.server}`;
                proxyUrl = new URL(raw);
            } catch (error) {
                reject(new Error(`Invalid proxy configuration: ${proxy.server}`));
                return;
            }
            const connectHeaders = {};
            if (proxy.username || proxy.password) {
                connectHeaders["Proxy-Authorization"] =
                    "Basic " + Buffer.from(`${proxy.username || ""}:${proxy.password || ""}`).toString("base64");
            }
            const connectReq = http.request({
                headers: connectHeaders,
                host: proxyUrl.hostname,
                method: "CONNECT",
                path: `${targetHost}:443`,
                port: proxyUrl.port ? parseInt(proxyUrl.port, 10) : 80,
            });
            const timer = setTimeout(() => {
                connectReq.destroy();
                reject(new Error(`timeout after ${timeoutMs}ms`));
            }, timeoutMs);
            connectReq.on("connect", (connectRes, socket) => {
                if (connectRes.statusCode !== 200) {
                    clearTimeout(timer);
                    socket.destroy();
                    reject(new Error(`proxy CONNECT rejected with HTTP ${connectRes.statusCode}`));
                    return;
                }
                const secureSocket = tls.connect({ servername: targetHost, socket });
                this._writeRequest(
                    secureSocket,
                    { body, headers, method, pathSuffix, targetHost },
                    resolve,
                    reject,
                    timer
                );
            });
            connectReq.on("error", error => {
                clearTimeout(timer);
                reject(error);
            });
            connectReq.end();
        });
    }

    _directRequest({ body, headers, method, pathSuffix, targetHost, timeoutMs = 30000 }) {
        return new Promise((resolve, reject) => {
            const request = https.request({ headers, host: targetHost, method, path: pathSuffix, port: 443 });
            const timer = setTimeout(() => {
                request.destroy();
                reject(new Error(`timeout after ${timeoutMs}ms`));
            }, timeoutMs);
            request.on("error", error => {
                clearTimeout(timer);
                reject(error);
            });
            request.on("response", response => this._readResponse(response, resolve, reject, timer));
            request.end(body || "");
        });
    }

    _writeRequest(socket, { body, headers, method, pathSuffix, targetHost }, resolve, reject, timer) {
        const lines = [`${method} ${pathSuffix} HTTP/1.1`, `Host: ${targetHost}`];
        for (const [name, value] of Object.entries(headers)) {
            lines.push(`${name}: ${value}`);
        }
        lines.push(`Content-Length: ${Buffer.byteLength(body || "")}`, "Connection: close", "", body || "");
        socket.on("secureConnect", () => socket.write(lines.join("\r\n")));
        socket.on("close", () => clearTimeout(timer));
        socket.on("error", error => {
            clearTimeout(timer);
            reject(error);
        });
        let raw = Buffer.alloc(0);
        socket.on("data", chunk => {
            raw = Buffer.concat([raw, chunk]);
            if (raw.length > MAX_RESPONSE_BYTES) {
                clearTimeout(timer);
                socket.destroy();
                reject(new Error("response exceeded size limit"));
            }
        });
        socket.on("end", () => {
            clearTimeout(timer);
            try {
                resolve(this._parseRawResponse(raw.toString("utf8")));
            } catch (error) {
                reject(error);
            }
        });
    }

    _readResponse(response, resolve, reject, timer) {
        let raw = Buffer.alloc(0);
        response.on("data", chunk => {
            raw = Buffer.concat([raw, chunk]);
            if (raw.length > MAX_RESPONSE_BYTES) {
                clearTimeout(timer);
                response.destroy();
                reject(new Error("response exceeded size limit"));
            }
        });
        response.on("end", () => {
            clearTimeout(timer);
            const headers = {};
            for (const [name, value] of Object.entries(response.headers)) {
                headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
            }
            resolve({
                body: this._decodeChunked(headers, raw.toString("utf8")),
                headers,
                status: response.statusCode || 0,
            });
        });
    }

    _parseRawResponse(text) {
        const separator = text.indexOf("\r\n\r\n");
        const head = separator >= 0 ? text.slice(0, separator) : text;
        const payload = separator >= 0 ? text.slice(separator + 4) : "";
        const headerLines = head.split("\r\n");
        const status = parseInt((headerLines[0] || "").split(" ")[1] || "0", 10);
        const headers = {};
        for (const line of headerLines.slice(1)) {
            const colon = line.indexOf(":");
            if (colon > 0) {
                headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
            }
        }
        return { body: this._decodeChunked(headers, payload), headers, status };
    }

    _decodeChunked(headers, payload) {
        if (!(headers["transfer-encoding"] || "").includes("chunked") || !payload) {
            return payload;
        }
        let out = "";
        let rest = payload;
        for (;;) {
            const newline = rest.indexOf("\r\n");
            if (newline < 0) {
                break;
            }
            const size = parseInt(rest.slice(0, newline), 16);
            if (!size) {
                break;
            }
            out += rest.slice(newline + 2, newline + 2 + size);
            rest = rest.slice(newline + 2 + size + 2);
        }
        return out;
    }
}

module.exports = AccountInfoRefresher;
