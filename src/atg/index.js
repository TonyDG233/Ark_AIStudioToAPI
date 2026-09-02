/**
 * File: src/atg/index.js
 * Description: ATG (Anti-Truncation Gateway) facade — assembles config, injector, extractors
 * and history purge into the single entry point used by RequestHandler.
 * Provides the complete post-processing pipeline for the synthetic transport tool:
 *   wrap request  ->  upstream (AI Studio)  ->  unwrap stream/non-stream  ->  client
 */
const { loadAtgConfig } = require("./config");
const { createInjector } = require("./injector");
const { createExtractor } = require("./extractor");
const { createStreamExtractor } = require("./streamExtractor");
const { purgeSyntheticHistory } = require("./historyPurge");

function createAtgProcessor(cfgOverrides = {}) {
    const cfg = loadAtgConfig(cfgOverrides);
    let injector = null;
    let extractor = null;

    if (cfg.enabled) {
        injector = createInjector(cfg);
        extractor = createExtractor(cfg);
    }

    return {
        cfg,
        /**
         * Create a stateful per-stream unwrapper (Gemini SSE chunk transformer).
         */
        createStreamUnwrapper(toolName) {
            return createStreamExtractor(cfg, toolName);
        },

        enabled: cfg.enabled,

        isSyntheticToolName(name) {
            return typeof name === "string" && name.startsWith(cfg.toolPrefix);
        },

        /**
         * Unwrap a non-streaming Gemini response.
         * Returns { response, stats }. Throws on unrecoverable synthetic arguments
         * or when wrapperMode=required is not satisfied.
         */
        unwrapResponse(response, toolName) {
            if (!cfg.enabled || !toolName) {
                return { response, stats: null };
            }
            const result = extractor.normalizeNonStreaming(response, toolName);
            return { response: result.response, stats: result.stats };
        },

        /**
         * Wrap an outgoing native Gemini request body.
         * Returns { body, toolName, syntheticHit }.
         * Purging stale synthetic history happens here, before injection.
         * modelName: explicit model id (Gemini body has no top-level model field).
         */
        wrap(body, modelName = "") {
            if (!cfg.enabled || !body || typeof body !== "object") {
                return { body, syntheticHit: false, toolName: "" };
            }

            if (Array.isArray(body.contents)) {
                body.contents = purgeSyntheticHistory(body.contents, cfg.toolPrefix);
            }

            return injector.injectGemini(body, modelName);
        },
    };
}

module.exports = { createAtgProcessor };
