/**
 * File: src/core/DirectSignerService.js
 * Description: Direct signer pipeline — page-credential harvesting over WebSocket and
 * a no-interception transport for real-streaming generation requests.
 *
 * Enabled by MAKERSUITE_DIRECT=on (default off). When enabled:
 *   - BrowserManager injects installDirectSigner() into the MAIN ai.studio page realm;
 *   - the injected script holds a WebSocket to the fixed internal port (role=signer),
 *     harvests the host's MakerSuite RPC credentials (headers) and captures the WAA
 *     client instance via an M.Cn wrapper;
 *   - generation requests designated for this path are dispatched as tasks over that
 *     WebSocket, executed in the page with a direct GenerateContent call, and the
 *     decoded Gemini SSE frames stream back progressively into the existing
 *     MessageQueue pipeline (same event shapes as build.js).
 *
 * Zero Playwright route interception, no loopback endpoint, no envelope rewriting.
 * Pieces reused from the archived bridge (fix/makersuite-generatecontent-bridge):
 * codec factory serialization, scanArrayElements frame splitter, header allowlist
 * harvest, M.Cn capture, progressive read loop.
 *
 * Author: TonyDG (direct signer port)
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");

// The page-side signer needs the pure codec in the page realm. Serialize it as a
// self-contained factory expression (the file has no requires).
const CODEC_FACTORY = (() => {
    try {
        const src = fs.readFileSync(path.join(__dirname, "MakerSuiteCodec.js"), "utf8");
        const marker = "module.exports";
        const idx = src.indexOf(marker);
        if (idx < 0) return "";
        const tail = src.slice(idx + marker.length).replace(/^\s*=\s*/, "return ");
        return `(() => {${src.slice(0, idx)}${tail} })()`;
    } catch {
        return "";
    }
})();

// Incremental splitter for the outer JSON array of a streamed GenerateContent
// body. Stateful across reads: { started, ended, pos }. Pure string scanning;
// serialized into the page realm like the codec factory.
function scanArrayElements(buffer, state) {
    const out = [];
    if (state.ended) return out;
    if (!state.started) {
        const i = buffer.indexOf("[");
        if (i < 0) return out;
        state.outerStart = i;
        state.pos = i + 1;
        state.started = true;
    }
    for (;;) {
        while (state.pos < buffer.length && (buffer[state.pos] === "," || /\s/.test(buffer[state.pos]))) state.pos++;
        if (state.pos >= buffer.length) break;
        if (buffer[state.pos] === "]") {
            state.ended = true;
            break;
        }
        const start = state.pos;
        let depth = 0,
            inStr = false,
            esc = false,
            q = start,
            end = -1,
            outerClosed = false;
        for (; q < buffer.length; q++) {
            const ch = buffer[q];
            if (inStr) {
                if (esc) esc = false;
                else if (ch === "\\") esc = true;
                else if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') inStr = true;
            else if (ch === "[" || ch === "{") depth++;
            else if (ch === "]" || ch === "}") {
                if (depth === 0) {
                    end = q;
                    outerClosed = true;
                    break;
                }
                depth--;
                if (depth === 0) {
                    end = q + 1;
                    break;
                }
            } else if (ch === "," && depth === 0) {
                end = q;
                break;
            }
        }
        if (end < 0) break;
        if (end > start) {
            if (state.firstElemStart === undefined) state.firstElemStart = start;
            out.push(buffer.slice(start, end));
        }
        if (outerClosed) {
            state.ended = true;
            state.pos = q + 1;
            break;
        }
        state.pos = end;
    }
    return out;
}

// Serialized into the MAIN page realm, including Firefox's wrapped page window.
// No Node closures may be referenced here. Top frame only: the App preview iframe
// already runs its own build.js client and must not open a second signer socket.
/* eslint-env browser */
function installDirectSigner(codecFactory, options, scanArrayElements) {
    if (window.__directSigner) return;
    let isTop = false;
    try {
        isTop = window === window.top;
    } catch {
        isTop = false;
    }
    if (!isTop) return;

    const opts = options || {};
    const authIndex = opts.authIndex;
    const wsPort = opts.wsPort || 9998;
    const readyTimeoutMs = opts.readyTimeoutMs || 15000;
    const rpc = /MakerSuiteService\/Proxy(Unary|Streamed)Call(?:\?|$)/;
    const RPC_HEADER_ALLOWLIST = [
        "authorization",
        "content-type",
        "x-goog-api-key",
        "x-goog-authuser",
        "x-goog-ext-519733851-bin",
        "x-user-agent",
    ];
    const nativeFetch = window.fetch.bind(window);
    const tasks = new Map(); // taskId -> AbortController

    const safeLog = message => {
        try {
            console.debug(`[ProxyClient] ${message}`);
        } catch {
            /* logging is best effort */
        }
    };

    // Bounded diagnostics channel: reports signing inputs/outputs and egress
    // samples back to the server log for token-form alignment (see NetWatch).
    let noteLeft = 30;
    const note = (tag, value) => {
        if (noteLeft <= 0) return;
        noteLeft -= 1;
        try {
            send({ note: String(value).slice(0, 600), tag, type: "signer_note" });
        } catch {
            /* best effort */
        }
    };
    function describeSig(value) {
        try {
            if (typeof value === "string") return `str(${value.length}):${value.slice(0, 160)}`;
            if (value && typeof value.length === "number") {
                let text = "";
                try {
                    text = new TextDecoder().decode(value);
                } catch {
                    text = "";
                }
                const printable = text && !text.includes("\uFFFD") && /^[\x20-\x7E\u4e00-\u9FFF\s]*$/.test(text);
                if (printable) return `bytes(${value.length})~text:${text.slice(0, 200)}`;
                const head = Array.from(value.slice(0, 24), b => Number(b) & 255).join(",");
                return `bytes(${value.length}):hexhead:${head}`;
            }
            return `${typeof value}`;
        } catch {
            return "?";
        }
    }

    const service = {
        acquire() {
            if (service.tb) return true;
            const M = window.default_MakerSuite;
            if (!M) return false;
            try {
                let inst = null;
                if (typeof M.TB === "function") {
                    if (typeof M.n === "function") {
                        try {
                            inst = M.n(M.TB);
                        } catch {
                            /* Angular injector context unavailable (NG0203) */
                        }
                    }
                    if (!inst || !inst.mb) {
                        try {
                            inst = new M.TB();
                        } catch {
                            /* constructor requires an injection context */
                        }
                    }
                }
                if (inst && inst.mb) {
                    service.tb = inst;
                    service.tbOrigin = "self";
                    safeLog("[DirectSigner] token service resolved (self)");
                    return true;
                }
            } catch {
                /* acquisition is best effort; hook() capture is the reliable path */
            }
            return false;
        },

        closed: false,

        hook() {
            const M = window.default_MakerSuite;
            if (!M || !M.Cn || !M.GB) return "module_missing";
            if (!M.Cn.__directSignerHook) {
                const original = M.Cn;
                const wrapped = function (a) {
                    if (a && a.mb) {
                        // Different call sites pass different service instances; some
                        // carry no API key. Prefer instances that have one.
                        const currentKeyed = !!(service.tb && service.tb.mb && (service.tb.mb.jK || service.tb.mb.nK));
                        const nextKeyed = !!(a.mb.jK || a.mb.nK);
                        if (!service.tb || nextKeyed || !currentKeyed) {
                            service.tb = a;
                            service.tbOrigin = "hook";
                        }
                        notify();
                    }
                    const res = original.apply(this, arguments);
                    try {
                        Promise.resolve(res)
                            .then(v => note("Cn", `in1=${describeSig(arguments[1])} out=${describeSig(v)}`))
                            .catch(() => {});
                    } catch {
                        /* best effort */
                    }
                    return res;
                };
                wrapped.__directSignerHook = true;
                M.Cn = wrapped;
            }
            if (M.GB && !M.GB.__directSignerHook) {
                const originalGB = M.GB;
                const wrappedGB = function () {
                    const res = originalGB.apply(this, arguments);
                    try {
                        Promise.resolve(res)
                            .then(v => note("GB", `in0=${describeSig(arguments[0])} out=${describeSig(v)}`))
                            .catch(() => {});
                    } catch {
                        /* best effort */
                    }
                    return res;
                };
                wrappedGB.__directSignerHook = true;
                M.GB = wrappedGB;
            }
            return service.tb ? "ready" : "token_pending";
        },

        rpcHeaders: null,

        tb: null,

        tbOrigin: "",

        warmup: "",
    };

    let ws = null,
        wsOpen = false,
        reconnectDelay = 1500,
        reconnectTimer = null;

    function send(obj) {
        try {
            if (wsOpen && ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
        } catch {
            /* socket may be closing */
        }
    }

    let lastStatusAt = 0,
        lastStatusSig = "";
    function notify(force) {
        let ready = "error";
        try {
            ready = service.hook();
        } catch {
            /* module not ready yet */
        }
        const keyed = !!(service.tb && service.tb.mb && (service.tb.mb.jK || service.tb.mb.nK));
        const sig = [ready, !!service.tb, keyed, !!service.rpcHeaders, service.warmup].join("|");
        const now = Date.now();
        if (!force && sig === lastStatusSig && now - lastStatusAt < 3000) return;
        lastStatusSig = sig;
        lastStatusAt = now;
        send({
            authIndex,
            hasHeaders: !!service.rpcHeaders,
            hasToken: !!service.tb,
            keyed,
            origin: service.tbOrigin || "",
            ready,
            type: "signer_status",
            warmup: service.warmup,
        });
    }

    // Swallow one warm-up request locally: the Studio host has already constructed
    // the RPC (M.Cn called, headers set) by the time send() runs, so both captures
    // are complete. Never hit the network for it.
    function swallow(xhr, entry) {
        let readyState = 1,
            status = 0,
            statusText = "",
            responseText = "";
        const chunks = [];
        const own = (name, get) => {
            try {
                Object.defineProperty(xhr, name, { configurable: true, get });
            } catch {
                /* property may be non-configurable */
            }
        };
        const fire = type => {
            try {
                xhr.dispatchEvent(new Event(type));
            } catch {
                /* page event dispatch is best-effort */
            }
        };
        own("readyState", () => readyState);
        own("status", () => status);
        own("statusText", () => statusText);
        own("responseText", () => responseText);
        own("response", () => chunks);
        own("responseURL", () => entry.url || "");
        xhr.getAllResponseHeaders = () => "content-type: application/json+protobuf; charset=UTF-8\r\n";
        xhr.getResponseHeader = name =>
            /^content-type$/i.test(String(name)) ? "application/json+protobuf; charset=UTF-8" : null;
        fire("loadstart");
        setTimeout(() => {
            status = 400;
            statusText = "ERROR";
            responseText = '[3,"direct-signer warmup swallowed"]';
            readyState = 4;
            fire("readystatechange");
            fire("progress");
            fire("load");
            fire("loadend");
        }, 0);
    }

    async function runTask(task) {
        const id = task.id;
        const controller = new AbortController();
        tasks.set(id, controller);
        const finish = message => {
            tasks.delete(id);
            send(message);
        };
        const cancelled = () => finish({ error: "[DirectSigner] cancelled", id, status: 502, type: "signer_error" });

        try {
            if (!service.codec || !service.codec.buildHashText) {
                return finish({
                    error: `[DirectSigner] codec unavailable: ${service.codecError || "unknown"}`,
                    id,
                    status: 502,
                    type: "signer_error",
                });
            }
            let g;
            try {
                g = JSON.parse(task.body || "{}");
            } catch (e) {
                return finish({
                    error: `[DirectSigner] invalid request JSON: ${String((e && e.message) || "invalid request")}`,
                    id,
                    status: 400,
                    type: "signer_error",
                });
            }
            if (controller.signal.aborted) return cancelled();

            service.acquire();
            const readyDeadline = Date.now() + readyTimeoutMs;
            while (service.hook() !== "ready") {
                if (controller.signal.aborted) return cancelled();
                if (Date.now() >= readyDeadline) {
                    return finish({
                        error: "[DirectSigner] token service not ready",
                        id,
                        status: 502,
                        type: "signer_error",
                    });
                }
                await new Promise(resolve => setTimeout(resolve, 25));
            }

            const M = window.default_MakerSuite,
                tb = service.tb;
            const metadata = tb.getMetadata(),
                mb = tb.mb;
            const apiKey = mb.jK || mb.nK || metadata["X-Goog-Api-Key"];
            const headers = {
                authorization: metadata.Authorization,
                "content-type": "application/json+protobuf",
                "x-goog-authuser": String(mb.Ml),
                "x-user-agent": "grpc-web-javascript/0.1",
            };
            if (typeof apiKey === "string" && apiKey.length >= 20) headers["x-goog-api-key"] = apiKey;
            if (service.rpcHeaders) {
                for (const name of RPC_HEADER_ALLOWLIST) {
                    if (typeof service.rpcHeaders[name] === "string" && service.rpcHeaders[name])
                        headers[name] = service.rpcHeaders[name];
                }
            }
            // Host scheme (observed on warm-up egress): M.Cn(tb, M.GB(path + " " + bodyJson)).
            const pathElement = `/v1beta/models/${task.model}:streamGenerateContent`;
            const jsonText = typeof task.body === "string" && task.body ? task.body : JSON.stringify(g);
            const token = await M.Cn(tb, await M.GB(`${pathElement} ${jsonText}`));
            if (!token) {
                return finish({
                    error: "[DirectSigner] token empty",
                    id,
                    status: 502,
                    type: "signer_error",
                });
            }
            if (controller.signal.aborted) return cancelled();

            // ProxyStreamedCall carries the raw Gemini JSON verbatim (the same shape
            // the native host sends): [path, JSON string, signed token]. No positional
            // compilation involved, so every request form (ANY tool choice, etc.)
            // rides the direct channel as-is.
            const payload = [pathElement, jsonText, token];
            const upstream = await nativeFetch(
                mb.F + "/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ProxyStreamedCall",
                {
                    body: JSON.stringify(payload),
                    credentials: "include",
                    headers,
                    method: "POST",
                    signal: controller.signal,
                }
            );
            if (upstream.status !== 200 || !upstream.body) {
                const text = await upstream.text();
                let normalized = {
                    body: JSON.stringify([14, "unexpected upstream failure"]),
                    status: upstream.status || 502,
                };
                try {
                    normalized = service.codec.errorEnvelope(text, upstream.status);
                } catch {
                    /* fall back to the raw text */
                }
                let detail = "";
                try {
                    const parsed = JSON.parse(String(normalized.body));
                    if (Array.isArray(parsed) && typeof parsed[1] === "string") detail = parsed[1];
                } catch {
                    /* keep the raw fallback below */
                }
                if (!detail) detail = String(normalized.body || text);
                return finish({
                    error: `[DirectSigner] upstream (HTTP ${normalized.status}) rejected the request: ${detail}`.slice(
                        0,
                        2000
                    ),
                    id,
                    sample: String(text).replace(/\s+/g, " ").slice(0, 300),
                    status: normalized.status,
                    type: "signer_error",
                });
            }

            send({ id, type: "signer_started" });

            const decoder = new TextDecoder();
            const flat = { ended: false, pos: 0, started: false };
            const inner = { ended: false, pos: 0, started: false };
            const reader = upstream.body.getReader();
            const taskT0 = Date.now();
            let reads = 0,
                firstReadMs = 0,
                lastReadMs = 0;
            // Chunks may be wrapped in one extra array ([[chunk,...]] — the form
            // observed live) or delivered flat ([chunk,...]). While the envelope is
            // undecided both scans run over the same buffer; whichever yields a
            // convertible chunk first locks the mode, so delivery stays progressive
            // in either form (the non-locked scan only ever yields structural
            // fragments that do not convert).
            let mode = 0;
            let buffer = "",
                frames = 0,
                droppedElements = 0;
            const droppedSamples = [];
            const emitValue = value => {
                send({ data: `data: ${JSON.stringify(value)}\n\n`, id, type: "signer_frame" });
                frames++;
                safeLog(`[DirectSigner] frame#${frames} at +${Date.now() - taskT0}ms`);
            };
            const emitChunk = parsed => {
                let value = parsed;
                if (typeof value === "string") {
                    try {
                        value = JSON.parse(value);
                    } catch {
                        return false;
                    }
                }
                if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") {
                    try {
                        value = JSON.parse(value[0]);
                    } catch {
                        return false;
                    }
                }
                if (value && typeof value === "object" && (value.candidates || value.usageMetadata)) {
                    emitValue(value);
                    return true;
                }
                if (!Array.isArray(value)) return false;
                let chunk = null;
                try {
                    chunk = service.codec.convChunk(value);
                } catch {
                    chunk = null;
                }
                if (chunk && (chunk.candidates || chunk.usageMetadata)) {
                    emitValue(chunk);
                    return true;
                }
                return false;
            };
            const consume = scanState => {
                let convertedAny = false;
                for (const elem of scanArrayElements(buffer, scanState)) {
                    let parsed = null;
                    try {
                        parsed = JSON.parse(elem);
                    } catch {
                        parsed = null;
                    }
                    const ok = parsed ? emitChunk(parsed) : false;
                    if (ok) {
                        convertedAny = true;
                    } else {
                        droppedElements++;
                        if (droppedSamples.length < 3) {
                            droppedSamples.push(String(elem).replace(/\s+/g, " ").slice(0, 90));
                        }
                    }
                }
                return convertedAny;
            };
            for (;;) {
                const { done: readDone, value } = await reader.read();
                reads++;
                if (!firstReadMs) firstReadMs = Date.now() - taskT0;
                lastReadMs = Date.now() - taskT0;
                if (readDone) break;
                if (!wsOpen) {
                    try {
                        controller.abort();
                    } catch {
                        /* already aborted */
                    }
                    break;
                }
                buffer += decoder.decode(value, { stream: true });
                if (mode === 2) {
                    consume(inner);
                } else if (mode === 1) {
                    consume(flat);
                } else {
                    // Undecided: probe inside the first nested bracket first (the
                    // wrapped case), then the flat scan. First convertible chunk wins.
                    if (!inner.started && flat.outerStart !== undefined) {
                        const nested = buffer.indexOf("[", flat.outerStart + 1);
                        if (nested >= 0) {
                            inner.pos = nested + 1;
                            inner.started = true;
                        }
                    }
                    if (inner.started && consume(inner)) {
                        mode = 2;
                    } else if (consume(flat)) {
                        mode = 1;
                    }
                }
                if (mode === 2 && inner.ended) break;
                if (mode !== 2 && flat.ended) break;
            }
            // Recovery: the observed streamed envelope appears in two forms
            // ([chunk,...] and [[chunk,...]]) and RPC error records can hide in an
            // HTTP 200 array. When the incremental scan produced nothing, re-parse
            // the whole body: error records become proper errors, chunks in either
            // envelope are converted individually, and a raw sample is attached for
            // diagnosis when nothing converts.
            if (frames === 0) {
                const sample = buffer.slice(0, 12000);
                let recovered = 0;
                let wrapError = null;
                try {
                    const normalized = service.codec.wrapResponse(buffer, true);
                    const wrapped = JSON.parse(normalized);
                    const list = Array.isArray(wrapped) && Array.isArray(wrapped[0]) ? wrapped[0] : [];
                    for (const entry of list) {
                        try {
                            let parsed = null;
                            if (typeof entry === "string") parsed = JSON.parse(entry);
                            else if (Array.isArray(entry) && entry.length === 1 && typeof entry[0] === "string")
                                parsed = JSON.parse(entry[0]);
                            else parsed = entry;
                            if (parsed && (parsed.candidates || parsed.usageMetadata)) {
                                send({ data: `data: ${JSON.stringify(parsed)}\n\n`, id, type: "signer_frame" });
                                recovered++;
                            }
                        } catch {
                            /* skip malformed entry */
                        }
                    }
                } catch (e) {
                    wrapError = e;
                }
                if (recovered === 0) {
                    // ProxyStreamedCall holder form: [[["chunk"],["chunk"],...]] - direct
                    // parse and pull the single-string holders.
                    try {
                        const wrappedDirect = JSON.parse(buffer);
                        const list =
                            Array.isArray(wrappedDirect) && Array.isArray(wrappedDirect[0]) ? wrappedDirect[0] : [];
                        for (const entry of list) {
                            try {
                                const parsed =
                                    typeof entry === "string"
                                        ? JSON.parse(entry)
                                        : Array.isArray(entry) && entry.length === 1 && typeof entry[0] === "string"
                                          ? JSON.parse(entry[0])
                                          : entry;
                                if (parsed && (parsed.candidates || parsed.usageMetadata)) {
                                    send({ data: `data: ${JSON.stringify(parsed)}\n\n`, id, type: "signer_frame" });
                                    recovered++;
                                }
                            } catch {
                                /* skip malformed entry */
                            }
                        }
                    } catch {
                        /* fall through to the walker */
                    }
                }
                if (recovered === 0) {
                    // ProxyStreamedCall form: nested arrays whose leaves are escaped JSON
                    // strings carrying Gemini REST chunks. Walk the whole body and
                    // double-parse every string leaf; emit whatever looks like a chunk.
                    try {
                        const walk = node => {
                            if (typeof node === "string") {
                                let inner = null;
                                try {
                                    inner = JSON.parse(node);
                                } catch {
                                    return;
                                }
                                if (inner && (inner.candidates || inner.usageMetadata)) {
                                    send({ data: `data: ${JSON.stringify(inner)}\n\n`, id, type: "signer_frame" });
                                    recovered++;
                                } else {
                                    walk(inner);
                                }
                            } else if (Array.isArray(node)) {
                                for (const child of node) walk(child);
                            } else if (node && typeof node === "object" && (node.candidates || node.usageMetadata)) {
                                send({ data: `data: ${JSON.stringify(node)}\n\n`, id, type: "signer_frame" });
                                recovered++;
                            }
                        };
                        walk(JSON.parse(buffer));
                    } catch {
                        /* keep the sample-based failure below */
                    }
                }
                if (recovered === 0) {
                    let errorText = "[DirectSigner] upstream response produced no convertible chunks";
                    if (wrapError) {
                        const rpcMessage =
                            Array.isArray(wrapError.rpcStatus) && typeof wrapError.rpcStatus[1] === "string"
                                ? wrapError.rpcStatus[1]
                                : "";
                        errorText = `[DirectSigner] stream error: ${(
                            rpcMessage || String((wrapError && wrapError.message) || wrapError)
                        ).slice(0, 300)}`;
                    }
                    return finish({
                        error: errorText,
                        id,
                        sample,
                        status: (wrapError && wrapError.status) || 502,
                        type: "signer_error",
                    });
                }
                frames = recovered;
            }
            safeLog(`[DirectSigner] task done id=${id} frames=${frames}`);
            finish({
                bytes: buffer.length,
                dropped: droppedElements,
                droppedSamples,
                firstReadMs,
                id,
                lastReadMs,
                reads,
                type: "signer_done",
            });
        } catch (e) {
            if (controller.signal.aborted) return cancelled();
            finish({
                error: `[DirectSigner] browser transport failed: ${String((e && e.message) || e).slice(0, 300)}`,
                id,
                status: 502,
                type: "signer_error",
            });
        }
    }

    function handleServerMessage(message) {
        if (!message || typeof message !== "object") return;
        if (message.type === "signer_task" && message.task) {
            runTask(message.task);
            return;
        }
        if (message.type === "signer_cancel" && message.id) {
            const controller = tasks.get(message.id);
            if (controller) controller.abort();
        }
    }

    function connect() {
        if (service.closed) return;
        try {
            ws = new WebSocket(`ws://127.0.0.1:${wsPort}?authIndex=${authIndex}&role=signer`);
        } catch {
            scheduleReconnect();
            return;
        }
        ws.addEventListener("open", () => {
            wsOpen = true;
            reconnectDelay = 1500;
            safeLog(`[DirectSigner] ws open (authIndex=${authIndex})`);
            notify(true);
        });
        ws.addEventListener("close", () => {
            wsOpen = false;
            safeLog("[DirectSigner] ws closed, reconnecting");
            scheduleReconnect();
        });
        ws.addEventListener("error", () => {
            /* close event follows and schedules the reconnect */
        });
        ws.addEventListener("message", event => {
            let message = null;
            try {
                message = JSON.parse(event.data);
            } catch {
                return;
            }
            handleServerMessage(message);
        });
    }

    function scheduleReconnect() {
        if (service.closed || reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 8000);
    }

    if (codecFactory) {
        try {
            // eslint-disable-next-line no-eval
            service.codec = (0, eval)(codecFactory);
        } catch (e) {
            service.codecError = String((e && e.message) || e);
        }
    }

    window.__directSigner = service;

    // Harvest credentials from the host's own RPC XHRs. No URL rewriting, no
    // interception of real traffic: the only swallowed request is the local
    // warm-up marker (never sent to the network).
    const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (proto) {
        const open = proto.open,
            setRequestHeader = proto.setRequestHeader,
            send = proto.send;
        const state = new WeakMap();
        proto.open = function (method, url) {
            let matches = false;
            try {
                matches = rpc.test(String(url));
            } catch {
                matches = false;
            }
            state.set(this, { headers: {}, matches, url: String(url) });
            return open.apply(this, arguments);
        };
        proto.setRequestHeader = function (name, value) {
            const entry = state.get(this);
            if (entry && entry.matches) {
                try {
                    entry.headers[String(name).toLowerCase()] = String(value);
                } catch {
                    /* header recording is best effort */
                }
            }
            return setRequestHeader.apply(this, arguments);
        };
        proto.send = function () {
            const entry = state.get(this);
            if (entry && entry.matches) {
                const harvested = {};
                for (const name of RPC_HEADER_ALLOWLIST) {
                    if (typeof entry.headers[name] === "string" && entry.headers[name])
                        harvested[name] = entry.headers[name];
                }
                if (Object.keys(harvested).length) {
                    service.rpcHeaders = Object.assign(service.rpcHeaders || {}, harvested);
                    notify();
                }
                const rawBody = typeof arguments[0] === "string" ? arguments[0] : null;
                if (rawBody && rawBody.indexOf("__warmup__") !== -1) {
                    service.warmup = "swallowed";
                    notify(true);
                    safeLog("[DirectSigner] warmup request swallowed (credentials captured)");
                    note("egress", rawBody.slice(0, 900));
                    return swallow(this, entry);
                }
            }
            return send.apply(this, arguments);
        };
    }

    // Observe-only fetch hook: some Studio bundles issue the RPC through fetch.
    window.fetch = function (input, init) {
        try {
            const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
            if (rpc.test(url)) {
                const headerBag = new Headers(
                    (init && init.headers) || (input instanceof Request ? input.headers : undefined)
                );
                const harvested = {};
                for (const name of RPC_HEADER_ALLOWLIST) {
                    const value = headerBag.get(name);
                    if (value) harvested[name] = value;
                }
                if (Object.keys(harvested).length) {
                    service.rpcHeaders = Object.assign(service.rpcHeaders || {}, harvested);
                    notify();
                }
            }
        } catch {
            /* harvesting is best effort */
        }
        return nativeFetch(input, init);
    };

    service.timer = setInterval(() => {
        const ready = service.hook() === "ready";
        notify();
        if (ready) clearInterval(service.timer);
    }, 1000);
    window.addEventListener(
        "pagehide",
        () => {
            service.closed = true;
            clearInterval(service.timer);
            try {
                if (ws) ws.close();
            } catch {
                /* already closing */
            }
        },
        { once: true }
    );

    connect();
}
/* eslint-env node */

function pageEval(source) {
    // Firefox Playwright may execute in a wrapped realm. Always use the page's own objects.
    const target = window.wrappedJSObject || window;
    return target.eval(source);
}

class DirectSignerService {
    constructor({ connectionRegistry, config, logger }) {
        this.connectionRegistry = connectionRegistry;
        this.config = config;
        this.logger = logger;
        // Map: authIndex -> signer WebSocket
        this.connections = new Map();
        // Map: authIndex -> latest signer_status message
        this.status = new Map();
        // Map: taskId -> task record
        this.tasks = new Map();
        // Map: requestId -> taskId
        this.requestToTask = new Map();
        // Map: authIndex -> in-flight warmup promise
        this.warmupInFlight = new Map();
        // Warm-up also needs the build.js connection (the host only constructs an
        // RPC when the App asks for one). Trigger when that client connects; the
        // single-flight guard makes repeats cheap.
        this.connectionRegistry.on("connectionAdded", ws => {
            const authIndex = ws && ws._authIndex;
            if (!Number.isInteger(authIndex) || authIndex < 0) return;
            setTimeout(() => {
                this._ensureWarmup(authIndex).catch(() => {});
            }, 1500);
        });
    }

    get enabled() {
        if (this.config && typeof this.config.makerSuiteDirect === "boolean") {
            return this.config.makerSuiteDirect;
        }
        return String(process.env.MAKERSUITE_DIRECT || "").toLowerCase() === "on";
    }

    /** Attach the BrowserManager reference (for live-page injection when toggled on). */
    attachBrowserManager(browserManager) {
        this.browserManager = browserManager;
    }

    /**
     * Runtime channel switch (UI/env-controlled). Enabling injects the page script into
     * every live context page and kicks warm-ups; disabling simply stops dispatching
     * (the page script idles and will not be installed into new contexts).
     */
    async setEnabled(value) {
        const enabled = !!value;
        if (this.config) {
            this.config.makerSuiteDirect = enabled;
        }
        this.logger.info(`[DirectSigner] channel switched ${enabled ? "ON" : "OFF"} (runtime)`);
        if (enabled) {
            await this._injectIntoLivePages();
            for (const authIndex of this.connections.keys()) {
                setTimeout(() => this._ensureWarmup(authIndex).catch(() => {}), 1500);
            }
        }
        return enabled;
    }

    async _injectIntoLivePages() {
        const browserManager = this.browserManager;
        if (!browserManager || !browserManager.contexts) return;
        for (const [authIndex, entry] of browserManager.contexts.entries()) {
            const page = entry && (entry.page || (entry.context && entry.context.pages()[0]));
            if (!page || page.isClosed()) continue;
            try {
                await page.evaluate(pageEval, this.buildInstallSource(authIndex));
                this.logger.debug(`[DirectSigner] page script injected into live context a#${authIndex}`);
            } catch (error) {
                this.logger.warn(`[DirectSigner] live injection failed for a#${authIndex}: ${error.message}`);
            }
        }
    }

    /**
     * Build the addInitScript content for one auth context. The page script opens
     * its own WebSocket back to this server (role=signer) and executes tasks.
     */
    buildInstallSource(authIndex) {
        const options = JSON.stringify({ authIndex, readyTimeoutMs: 15000, wsPort: 9998 });
        return `(${installDirectSigner.toString()})(${JSON.stringify(CODEC_FACTORY)},${options},(${scanArrayElements.toString()}))`;
    }

    buildInitScript(authIndex) {
        return `(${pageEval.toString()})(${JSON.stringify(this.buildInstallSource(authIndex))})`;
    }

    registerConnection(ws, authIndex, req) {
        const existing = this.connections.get(authIndex);
        if (existing && existing !== ws) {
            this.logger.warn(`[DirectSigner] replacing previous signer connection (authIndex=${authIndex})`);
            try {
                existing.removeAllListeners();
                existing.close(1000, "Replaced by new signer connection");
            } catch {
                /* ignore */
            }
        }
        this.connections.set(authIndex, ws);
        this.logger.info(
            `[DirectSigner] signer connected (authIndex=${authIndex}, from=${req?.socket?.remoteAddress || "unknown"})`
        );
        ws.on("message", data => this._onMessage(authIndex, data));
        ws.on("close", () => {
            if (this.connections.get(authIndex) === ws) {
                this.connections.delete(authIndex);
                this.logger.info(`[DirectSigner] signer disconnected (authIndex=${authIndex})`);
            }
            this._failTasksForAuth(authIndex, "signer connection lost");
        });
        ws.on("error", error => {
            this.logger.warn(`[DirectSigner] signer ws error (authIndex=${authIndex}): ${error.message}`);
        });
        // Proactive warm-up: build.js usually connects around the same time as the
        // page script; retry later when it is not up yet (single-flight, cheap).
        setTimeout(() => {
            this._ensureWarmup(authIndex).catch(() => {});
        }, 8000);
        setTimeout(() => {
            this._ensureWarmup(authIndex).catch(() => {});
        }, 20000);
    }

    /**
     * Decide whether this request can ride the direct signer path. Synchronous:
     * returns true when the task was dispatched. When the signer exists but its
     * token material is not ready yet, a warm-up is kicked off and the request
     * falls through to the native path (no new failure mode).
     */
    maybeHandleTask(proxyRequest, authIndex) {
        if (!this.enabled) return false;
        if (!proxyRequest || proxyRequest.is_generative !== true) return false;
        const requestId = proxyRequest.request_id || "(no-id)";
        // Static scope rule: the direct channel serves real-stream generation requests.
        // Other modes are not direct candidates (no runtime switching involved).
        if (proxyRequest.streaming_mode !== "real") {
            this.logger.debug(
                `[DirectSigner] request=${requestId}: not a direct candidate (streaming_mode=${
                    proxyRequest.streaming_mode || "unknown"
                })`
            );
            return false;
        }
        const match = String(proxyRequest.path || "").match(/\/v1beta\/models\/([^:/?]+):streamGenerateContent/);
        if (!match) return false;

        // From here on the request IS a direct candidate: it is served by the direct
        // channel or refused with a visible error. There is deliberately NO automatic
        // delegation back to the native path — silent rerouting would mask failures
        // (and would break the "native channel is down, direct is the backup" scenario).
        const ws = this.connections.get(authIndex);
        if (!ws || ws.readyState !== 1) {
            return this._refuseDirect(proxyRequest, authIndex, `signer channel offline for a#${authIndex}`);
        }
        const status = this.status.get(authIndex);
        if (!status || status.ready !== "ready") {
            this._ensureWarmup(authIndex).catch(() => {});
            return this._refuseDirect(
                proxyRequest,
                authIndex,
                `signer not ready for a#${authIndex} yet (warmup triggered; retry shortly)`
            );
        }

        const taskId = `ds_${randomUUID()}`;
        const task = {
            attemptId: proxyRequest.request_attempt_id || null,
            authIndex,
            cancelled: false,
            frames: 0,
            requestId: proxyRequest.request_id,
            startedAt: Date.now(),
            taskId,
            watchdog: null,
        };
        task.watchdog = setTimeout(() => {
            this.logger.warn(`[DirectSigner] task watchdog fired request=${task.requestId}`);
            this._inject(taskId, {
                event_type: "error",
                message: "[DirectSigner] generation deadline exceeded",
                status: 504,
            });
            this._finishTask(taskId, "watchdog");
        }, this._taskTimeoutMs());
        this.tasks.set(taskId, task);
        this.requestToTask.set(task.requestId, taskId);

        try {
            ws.send(
                JSON.stringify({
                    task: { body: proxyRequest.body, id: taskId, model: match[1] },
                    type: "signer_task",
                })
            );
        } catch (error) {
            this._finishTask(taskId, "send_failed");
            return this._refuseDirect(proxyRequest, authIndex, `task send failed: ${error.message}`);
        }
        this.logger.debug(
            `[DirectSigner] request=${task.requestId}: serving via direct path — task dispatched a#${authIndex} model=${match[1]}`
        );
        return true;
    }

    /**
     * Refuse a direct-candidate request with a visible error instead of silently
     * rerouting it to the native path. The injected error carries skipAccountSwitch
     * so a channel problem is never counted as an account failure.
     */
    _refuseDirect(proxyRequest, authIndex, reason) {
        this.logger.warn(
            `[DirectSigner] request=${proxyRequest.request_id}: refused (${reason}); not delegating to native`
        );
        try {
            this.connectionRegistry.handleExternalMessage(
                {
                    event_type: "error",
                    message:
                        `[DirectSigner] ${reason}. While MAKERSUITE_DIRECT=on the direct channel serves ` +
                        "all real-stream generation requests; disable it to use the native path.",
                    request_attempt_id: proxyRequest.request_attempt_id,
                    request_id: proxyRequest.request_id,
                    skipAccountSwitch: true,
                    status: 502,
                },
                authIndex
            );
        } catch (error) {
            this.logger.error(`[DirectSigner] failed to inject refusal: ${error.message}`);
        }
        return true;
    }

    /**
     * Cancel an in-flight direct task (client disconnect or pre-retry cancel).
     */
    cancel(requestId, attemptId = null, authIndex = null) {
        const taskId = this.requestToTask.get(requestId);
        if (!taskId) return;
        const task = this.tasks.get(taskId);
        if (!task) {
            this.requestToTask.delete(requestId);
            return;
        }
        if (attemptId && task.attemptId && attemptId !== task.attemptId) return;
        if (Number.isInteger(authIndex) && authIndex >= 0 && task.authIndex !== authIndex) return;
        task.cancelled = true;
        const ws = this.connections.get(task.authIndex);
        if (ws && ws.readyState === 1) {
            try {
                ws.send(JSON.stringify({ id: taskId, type: "signer_cancel" }));
            } catch {
                /* socket may be closing */
            }
        }
        this._finishTask(taskId, "cancelled");
        this.logger.debug(`[DirectSigner] task cancelled request=${requestId}`);
    }

    _taskTimeoutMs() {
        const streamTimeout = (this.config && this.config.streamTimeoutMs) || 60000;
        return Math.min(300000, Math.max(60000, streamTimeout) + 30000);
    }

    _onMessage(authIndex, data) {
        let message = null;
        try {
            message = JSON.parse(data.toString());
        } catch {
            this.logger.warn("[DirectSigner] failed to parse signer message");
            return;
        }
        if (!message || typeof message !== "object") return;
        switch (message.type) {
            case "signer_status": {
                const previous = this.status.get(authIndex);
                this.status.set(authIndex, message);
                if (!previous || previous.ready !== message.ready || previous.warmup !== message.warmup) {
                    this.logger.debug(
                        `[DirectSigner] status a#${authIndex}: ready=${message.ready}, token=${
                            message.hasToken ? "yes" : "no"
                        }, keyed=${message.keyed ? "yes" : "no"}, headers=${
                            message.hasHeaders ? "yes" : "no"
                        }${message.warmup ? `, warmup=${message.warmup}` : ""}${
                            message.origin ? `, origin=${message.origin}` : ""
                        }`
                    );
                }
                break;
            }
            case "signer_started":
                this._inject(message.id, {
                    event_type: "response_headers",
                    headers: { "content-type": "text/event-stream" },
                    status: 200,
                });
                break;
            case "signer_frame": {
                const task = this.tasks.get(message.id);
                if (task) task.frames++;
                this._inject(message.id, { data: message.data, event_type: "chunk" });
                break;
            }
            case "signer_done": {
                const task = this.tasks.get(message.id);
                this._inject(message.id, { event_type: "stream_close" });
                if (task) {
                    const dropped = Number(message.dropped) || 0;
                    const samples =
                        dropped && Array.isArray(message.droppedSamples) && message.droppedSamples.length
                            ? ` droppedSamples=${JSON.stringify(message.droppedSamples)}`
                            : "";
                    this.logger.debug(
                        `[DirectSigner] task done request=${task.requestId} frames=${task.frames} bytes=${
                            message.bytes || 0
                        } reads=${message.reads || 0} readMs=[${message.firstReadMs || 0},${
                            message.lastReadMs || 0
                        }] dropped=${dropped}${samples}`
                    );
                }
                this._finishTask(message.id, "done");
                break;
            }
            case "signer_error": {
                const task = this.tasks.get(message.id);
                this._inject(message.id, {
                    event_type: "error",
                    message: String(message.error || "direct signer error"),
                    status: Number(message.status) || 502,
                });
                if (task) {
                    if (message.sample && String(message.sample).length > 300) {
                        try {
                            fs.writeFileSync(
                                path.join(os.tmpdir(), "direct-signer-sample.txt"),
                                String(message.sample)
                            );
                        } catch {
                            /* diagnostics only */
                        }
                    }
                    const detail = message.sample ? ` sample=${String(message.sample).replace(/\s+/g, " ")}` : "";
                    this.logger.warn(
                        `[DirectSigner] task error request=${task.requestId} status=${message.status}: ${
                            message.error || ""
                        }${detail}`
                    );
                }
                this._finishTask(message.id, "error");
                break;
            }
            case "signer_note":
                this.logger.debug(`[DirectSigner] note ${message.tag || ""}: ${String(message.note || "")}`);
                break;
            default:
                this.logger.debug(`[DirectSigner] unknown signer message type: ${message.type}`);
        }
    }

    _inject(taskId, message) {
        const task = this.tasks.get(taskId);
        if (!task || task.cancelled) return false;
        message.request_attempt_id = task.attemptId;
        message.request_id = task.requestId;
        return this.connectionRegistry.handleExternalMessage(message, task.authIndex);
    }

    _finishTask(taskId, reason) {
        const task = this.tasks.get(taskId);
        if (!task) return;
        if (task.watchdog) clearTimeout(task.watchdog);
        this.tasks.delete(taskId);
        if (this.requestToTask.get(task.requestId) === taskId) {
            this.requestToTask.delete(task.requestId);
        }
        this.logger.debug(`[DirectSigner] task cleaned (${reason}) request=${task.requestId}`);
    }

    _failTasksForAuth(authIndex, reason) {
        for (const task of Array.from(this.tasks.values())) {
            if (task.authIndex !== authIndex) continue;
            this._inject(task.taskId, {
                event_type: "error",
                message: `[DirectSigner] ${reason}`,
                status: 502,
            });
            this._finishTask(task.taskId, reason);
        }
    }

    _ensureWarmup(authIndex) {
        if (!this.enabled) return Promise.resolve(false);
        const status = this.status.get(authIndex);
        if (status && status.ready === "ready") return Promise.resolve(true);
        const ws = this.connections.get(authIndex);
        if (!ws || ws.readyState !== 1) return Promise.resolve(false);
        if (this.warmupInFlight.has(authIndex)) return this.warmupInFlight.get(authIndex);
        const promise = this._runWarmup(authIndex)
            .catch(() => false)
            .finally(() => this.warmupInFlight.delete(authIndex));
        this.warmupInFlight.set(authIndex, promise);
        return promise;
    }

    /**
     * Warm-up: ask the App client (build.js) for one marker generation request.
     * The page hook swallows it locally (zero upstream traffic, zero quota) while
     * capturing the host's fresh credentials; afterwards the signer reports ready.
     */
    async _runWarmup(authIndex) {
        const connection = this.connectionRegistry.getConnectionByAuth(authIndex, false);
        if (!connection) return false;
        const requestId = `direct_warmup_${randomUUID()}`;
        const attemptId = `${requestId}_attempt_1`;
        try {
            const queue = this.connectionRegistry.createMessageQueue(requestId, authIndex, attemptId);
            this.logger.debug(`[DirectSigner] warmup triggered (authIndex=${authIndex})`);
            connection.send(
                JSON.stringify({
                    body: JSON.stringify({ contents: [{ parts: [{ text: "warmup" }], role: "user" }] }),
                    event_type: "proxy_request",
                    headers: { "Content-Type": "application/json" },
                    is_generative: true,
                    method: "POST",
                    path: "/v1beta/models/__warmup__:streamGenerateContent",
                    query_params: { alt: "sse" },
                    request_attempt_id: attemptId,
                    request_id: requestId,
                    streaming_mode: "real",
                })
            );
            await queue.dequeue(15000).catch(() => null);
        } catch (e) {
            this.logger.debug(`[DirectSigner] warmup round-trip failed: ${e.message}`);
        } finally {
            this.connectionRegistry.removeMessageQueue(requestId, "warmup_done");
        }
        const deadline = Date.now() + 6000;
        while (Date.now() < deadline) {
            const status = this.status.get(authIndex);
            if (status && status.ready === "ready") {
                this.logger.debug(`[DirectSigner] warmup complete (authIndex=${authIndex})`);
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        this.logger.warn(`[DirectSigner] warmup finished without token capture (authIndex=${authIndex})`);
        return false;
    }
}

module.exports = DirectSignerService;
