/**
 * File: src/atg/extractor.js
 * Description: Non-streaming response normalizer (Gemini format) — ported from
 * Antigravity-gateway internal/synthetic/normalizer.go, adapted to Gemini
 * candidates[].content.parts[] with functionCall parts (args may be object or
 * malformed string in AI Studio quirks).
 */
const { repairSyntheticArguments } = require("./repair");

function extractContentFromArgs(args, cfg, stats) {
    if (args && typeof args === "object" && !Array.isArray(args)) {
        if (typeof args.content === "string") {
            return args.content;
        }
        throw new Error(
            `synthetic tool arguments must contain a string 'content' field, got: ${JSON.stringify(args).slice(0, 200)}`
        );
    }

    if (typeof args === "string") {
        const { content, error } = repairSyntheticArguments(args, cfg.maxResponseBytes || 16 * 1024 * 1024);
        if (error || typeof content !== "string") {
            throw new Error(`failed to decode synthetic tool arguments: ${error && error.message}`);
        }
        stats.repaired = true;
        return content;
    }

    throw new Error("synthetic tool call produced no parseable arguments");
}

function createExtractor(cfg) {
    return {
        normalizeNonStreaming(response, toolName) {
            const stats = {
                conflict: false,
                realToolCount: 0,
                repaired: false,
                syntheticCount: 0,
                syntheticHit: false,
            };

            if (cfg.wrapperMode === "off" || !toolName) {
                return { response, stats };
            }

            if (!response || !Array.isArray(response.candidates) || response.candidates.length === 0) {
                return { response, stats };
            }

            for (const candidate of response.candidates) {
                if (!candidate || !candidate.content || !Array.isArray(candidate.content.parts)) {
                    continue;
                }

                const parts = candidate.content.parts;
                const willHaveSynthetic = parts.some(p => p && p.functionCall && p.functionCall.name === toolName);
                const seesStandardText = parts.some(p => p && p.text && p.thought !== true);
                if (willHaveSynthetic && seesStandardText) {
                    stats.conflict = true;
                }

                const normalizedParts = [];

                for (const part of parts) {
                    if (!part) {
                        continue;
                    }

                    if (part.functionCall && part.functionCall.name === toolName) {
                        stats.syntheticHit = true;
                        stats.syntheticCount += 1;
                        const content = extractContentFromArgs(part.functionCall.args, cfg, stats);
                        normalizedParts.push({ text: content });
                        continue;
                    }

                    if (part.functionCall) {
                        stats.realToolCount += 1;
                        normalizedParts.push(part);
                        continue;
                    }

                    if (part.text && part.thought !== true && willHaveSynthetic) {
                        continue;
                    }

                    normalizedParts.push(part);
                }

                candidate.content = { ...candidate.content, parts: normalizedParts };

                if (willHaveSynthetic && candidate.finishReason === "TOOL_CALLS" && stats.realToolCount === 0) {
                    candidate.finishReason = "STOP";
                }
            }

            if (cfg.wrapperMode === "required" && !stats.syntheticHit && stats.realToolCount === 0) {
                throw new Error("synthetic tool call required but not present in upstream response");
            }

            return { response, stats };
        },
    };
}

module.exports = { createExtractor };
