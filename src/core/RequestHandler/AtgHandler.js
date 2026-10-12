/**
 * File: src/core/RequestHandler/AtgHandler.js
 * Description: ATG (Anti-Truncation Gateway) synthetic-transport post-processing for the
 * modular RequestHandler. Owns the per-instance processor (env-derived ATG_* options,
 * default mode "off"), the outgoing wrap applied on every generation body, the per-chunk
 * stream unwrapper and the non-stream response unwrapper. The per-request synthetic tool
 * name travels on res.__atgToolName, set once where the request body is prepared.
 * Logic ported from the pre-refactor RequestHandler.js (see git history).
 *
 * Author: TonyDG (ATG port)
 */

const { createAtgProcessor } = require("../../atg");

class AtgHandler {
    /**
     * [ATG] Lazily create the processor so construction order of composed handlers
     * does not matter. Options are read from ATG_* env on first use.
     */
    _ensureAtg() {
        if (!this.atg) {
            this.atg = createAtgProcessor();
        }
        return this.atg;
    }

    get atgMode() {
        return this._ensureAtg().cfg.mode;
    }

    /**
     * [ATG] Hot-switch the post-processing mode without restart (UI settings).
     * Keeps env-derived options (prefix/lengths/etc.), overriding only the mode.
     * Returns the effective mode.
     */
    setAtgMode(mode) {
        if (!["off", "prefer", "required"].includes(mode)) {
            return this.atgMode;
        }
        const current = this._ensureAtg().cfg || {};
        this.atg = createAtgProcessor({ ...current, mode });
        this.logger.debug(`[ATG] mode hot-switched to: ${this.atg.cfg.mode}`);
        return this.atg.cfg.mode;
    }

    /**
     * [ATG] Wrap an outgoing native Gemini body with the synthetic transport tool.
     * Purging stale synthetic history + injection happen inside; returns the modified
     * body and the per-request synthetic tool name ("" when skipped).
     * modelName is passed explicitly because the Gemini body has no top-level model field.
     */
    _applyAtgWrap(googleBody, contextLabel, modelName = "") {
        const atg = this._ensureAtg();
        if (!atg.enabled) {
            return { body: googleBody, toolName: "" };
        }
        try {
            const wrapped = atg.wrap(googleBody, modelName);
            if (wrapped.toolName) {
                this.logger.debug(
                    `[ATG] wrapped (${contextLabel}): tool=${wrapped.toolName}, ` +
                        `model=${modelName || (googleBody && googleBody.model)}, ` +
                        `contents=${Array.isArray(googleBody && googleBody.contents) ? googleBody.contents.length : 0}, ` +
                        `tools=${Array.isArray(googleBody && googleBody.tools) ? googleBody.tools.length : 0}`
                );
            } else {
                this.logger.debug(
                    `[ATG] wrap skipped (${contextLabel}): model=${modelName || (googleBody && googleBody.model)}`
                );
            }
            return { body: wrapped.body, toolName: wrapped.toolName };
        } catch (e) {
            this.logger.warn(`[ATG] wrap failed (${contextLabel}), proceeding without wrap: ${e.message}`);
            return { body: googleBody, toolName: "" };
        }
    }

    /**
     * [ATG] Pass one raw Gemini SSE chunk through the per-request stream unwrapper.
     * Returns the transformed chunk string, or null when the chunk was consumed
     * (buffered/suppressed) and must not be forwarded.
     * In real-stream mode message.data arrives as a raw SSE line "data: {...}",
     * so the prefix is stripped before parsing.
     */
    _processAtgStreamData(data, unwrapper, contextLabel) {
        if (!unwrapper) {
            return data;
        }

        const raw = data;
        let pending = null;
        if (typeof raw === "string") {
            let candidate = raw.trim();
            if (candidate.startsWith("data:")) {
                candidate = candidate.slice(5).trim();
            }
            if (candidate === "[DONE]") {
                return null;
            }
            pending = candidate;
        }

        if (pending === null || pending === "") {
            return null;
        }

        let parsed = null;
        try {
            parsed = JSON.parse(pending);
        } catch (e) {
            this.logger.warn(`[ATG] chunk parse failed (${contextLabel}), forwarding raw: ${e.message}`);
            return data;
        }
        try {
            const r = unwrapper.processChunk(parsed);
            if (!r || !r.data) {
                return null;
            }
            return `data: ${JSON.stringify(r.data)}`;
        } catch (e) {
            this.logger.warn(`[ATG] stream unwrap error (${contextLabel}), forwarding raw: ${e.message}`);
            return data;
        }
    }

    /**
     * [ATG] Create the per-request stream unwrapper from res.__atgToolName (only set when
     * the request body was wrapped). Returns null when ATG is inactive for this request.
     */
    _createAtgStreamUnwrapper(res) {
        const atgToolName = (res && res.__atgToolName) || "";
        if (!atgToolName) {
            return null;
        }
        return this._ensureAtg().createStreamUnwrapper(atgToolName);
    }

    /**
     * [ATG] Unwrap a non-streaming Gemini response before protocol conversion.
     * Returns the (possibly rewritten) response; any failure falls back to the raw one.
     */
    _unwrapAtgNonStreamResponse(googleResponse, res, contextLabel) {
        const atgToolName = (res && res.__atgToolName) || "";
        if (!atgToolName) {
            return googleResponse;
        }
        try {
            const unwrapped = this._ensureAtg().unwrapResponse(googleResponse, atgToolName);
            const s = unwrapped.stats;
            if (s && (s.syntheticHit || s.conflict || s.repaired)) {
                this.logger.debug(`[ATG] non-stream unwrap (${contextLabel}): stats=${JSON.stringify(s)}`);
            } else {
                this.logger.debug(`[ATG] non-stream passthrough (${contextLabel}): stats=${JSON.stringify(s)}`);
            }
            return unwrapped.response;
        } catch (e) {
            this.logger.warn(`[ATG] non-stream unwrap failed (${contextLabel}), forwarding raw: ${e.message}`);
            return googleResponse;
        }
    }
}

module.exports = AtgHandler;
