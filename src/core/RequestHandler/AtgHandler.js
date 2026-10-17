/**
 * File: src/core/RequestHandler/AtgHandler.js
 * Description: ATG (Anti-Truncation Gateway) synthetic-transport post-processing for the
 * modular RequestHandler. Owns ATG settings (global mode, per-API-format overrides and the
 * client-synthetic guard), the outgoing wrap applied on every generation body, the
 * per-chunk stream unwrapper and the non-stream response unwrapper. The per-request
 * synthetic tool name travels on res.__atgToolName (and the effective mode on
 * res.__atgMode), set once where the request body is prepared.
 *
 * Settings precedence: runtime values (UI hot-switches, seeded from ConfigLoader/env)
 * layered over ATG_* env. Logic ported from the pre-refactor RequestHandler.js.
 *
 * Author: TonyDG (ATG port)
 */

const { createAtgProcessor } = require("../../atg");

const ATG_MODES = ["off", "prefer", "required"];
const FORMAT_MODES = ["inherit", "off", "prefer", "required"];
const ATG_FORMATS = ["gemini", "openai", "claude"];

class AtgHandler {
    /**
     * [ATG] Lazily initialize the settings store so construction order of composed
     * handlers does not matter. Seed: env-derived base processor + ConfigLoader fields.
     */
    _atgSettings() {
        if (!this._atgState) {
            const base = createAtgProcessor();
            const config = this.config || {};
            const byFormat = { claude: "inherit", gemini: "inherit", openai: "inherit" };
            if (config.atgModeByFormat && typeof config.atgModeByFormat === "object") {
                for (const format of ATG_FORMATS) {
                    const value = String(config.atgModeByFormat[format] || "").toLowerCase();
                    if (FORMAT_MODES.includes(value)) {
                        byFormat[format] = value;
                    }
                }
            }
            this._atgState = {
                byFormat,
                globalMode: ATG_MODES.includes(base.cfg.mode) ? base.cfg.mode : "off",
                guard: typeof config.atgClientSyntheticGuard === "boolean" ? config.atgClientSyntheticGuard : true,
                processors: new Map([[base.cfg.mode, base]]),
            };
        }
        return this._atgState;
    }

    /** [ATG] Processor for one effective mode (cached; rebuilt when the guard flips). */
    _processorForMode(mode) {
        const state = this._atgSettings();
        let processor = state.processors.get(mode);
        if (!processor || processor.cfg.clientSyntheticGuard !== state.guard) {
            processor = createAtgProcessor({ clientSyntheticGuard: state.guard, mode });
            state.processors.set(mode, processor);
        }
        return processor;
    }

    /** [ATG] Map a call-site context label onto the per-format switch group. */
    _formatGroup(contextLabel) {
        if (contextLabel === "gemini") return "gemini";
        if (contextLabel === "claude") return "claude";
        return "openai";
    }

    /** [ATG] Effective mode for one context label (per-format override beats global). */
    _effectiveModeFor(contextLabel) {
        const state = this._atgSettings();
        const override = state.byFormat[this._formatGroup(contextLabel)];
        return override && override !== "inherit" ? override : state.globalMode;
    }

    get atgMode() {
        return this._atgSettings().globalMode;
    }

    get atgModeByFormat() {
        return { ...this._atgSettings().byFormat };
    }

    get atgClientSyntheticGuard() {
        return this._atgSettings().guard;
    }

    /**
     * [ATG] Hot-switch the global post-processing mode without restart (UI settings).
     * Returns the effective mode.
     */
    setAtgMode(mode) {
        const state = this._atgSettings();
        if (!ATG_MODES.includes(mode)) {
            return state.globalMode;
        }
        state.globalMode = mode;
        this.logger.debug(`[ATG] global mode hot-switched to: ${mode}`);
        return mode;
    }

    /**
     * [ATG] Hot-switch the mode for one API format (gemini|openai|claude).
     * "inherit" follows the global mode. Returns the new per-format value.
     */
    setAtgModeForFormat(format, mode) {
        const state = this._atgSettings();
        if (!ATG_FORMATS.includes(format) || !FORMAT_MODES.includes(mode)) {
            return state.byFormat[format] || "inherit";
        }
        state.byFormat[format] = mode;
        this.logger.debug(`[ATG] mode for ${format} hot-switched to: ${mode}`);
        return mode;
    }

    /**
     * [ATG] Hot-switch the client-synthetic-transport guard (detection that skips the
     * local wrap when the client already ships a similar mechanism). Returns the value.
     */
    setAtgClientSyntheticGuard(enabled) {
        const state = this._atgSettings();
        state.guard = !!enabled;
        state.processors.clear();
        this.logger.debug(`[ATG] client synthetic guard hot-switched to: ${state.guard}`);
        return state.guard;
    }

    /**
     * [ATG] Wrap an outgoing native Gemini body with the synthetic transport tool.
     * Purging stale synthetic history + injection happen inside; returns the modified
     * body, the per-request synthetic tool name ("" when skipped) and the effective mode.
     * modelName is passed explicitly because the Gemini body has no top-level model field.
     */
    _applyAtgWrap(googleBody, contextLabel, modelName = "") {
        const mode = this._effectiveModeFor(contextLabel);
        if (mode === "off") {
            return { body: googleBody, mode: "", toolName: "" };
        }
        const atg = this._processorForMode(mode);
        try {
            const wrapped = atg.wrap(googleBody, modelName);
            if (wrapped.clientSynthetic) {
                // This is the "local ATG temporarily disabled" trigger: keep it at INFO
                // so the auto-skip of the local wrap is always visible.
                this.logger.info(
                    `[ATG] client synthetic transport detected (${contextLabel}): tool=${
                        wrapped.clientSynthetic.name || "(instruction-only)"
                    }, reason=${wrapped.clientSynthetic.reason}; local wrap skipped for this request`
                );
                return { body: wrapped.body, mode: "", toolName: "" };
            }
            if (wrapped.toolName) {
                this.logger.debug(
                    `[ATG] wrapped (${contextLabel}, mode=${mode}): tool=${wrapped.toolName}, ` +
                        `model=${modelName || (googleBody && googleBody.model)}, ` +
                        `contents=${Array.isArray(googleBody && googleBody.contents) ? googleBody.contents.length : 0}, ` +
                        `tools=${Array.isArray(googleBody && googleBody.tools) ? googleBody.tools.length : 0}`
                );
                if (Array.isArray(wrapped.clientTools) && wrapped.clientTools.length) {
                    this.logger.debug(
                        `[ATG] client tools present (${contextLabel}, no synthetic pattern): ${JSON.stringify(
                            wrapped.clientTools
                        )}`
                    );
                }
            } else {
                this.logger.debug(
                    `[ATG] wrap skipped (${contextLabel}, mode=${mode}): model=${
                        modelName || (googleBody && googleBody.model)
                    }`
                );
            }
            return { body: wrapped.body, mode: wrapped.toolName ? mode : "", toolName: wrapped.toolName };
        } catch (e) {
            this.logger.warn(`[ATG] wrap failed (${contextLabel}), proceeding without wrap: ${e.message}`);
            return { body: googleBody, mode: "", toolName: "" };
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
     * the request body was wrapped). The processor matching the request's effective mode
     * (res.__atgMode) is used so per-format modes stay consistent end to end.
     * Returns null when ATG is inactive for this request.
     */
    _createAtgStreamUnwrapper(res) {
        const atgToolName = (res && res.__atgToolName) || "";
        if (!atgToolName) {
            return null;
        }
        const mode = ATG_MODES.includes(res && res.__atgMode) ? res.__atgMode : this.atgMode;
        return this._processorForMode(mode).createStreamUnwrapper(atgToolName);
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
            const mode = ATG_MODES.includes(res && res.__atgMode) ? res.__atgMode : this.atgMode;
            const unwrapped = this._processorForMode(mode).unwrapResponse(googleResponse, atgToolName);
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
