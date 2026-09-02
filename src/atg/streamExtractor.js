/**
 * File: src/atg/streamExtractor.js
 * Description: Per-chunk Gemini SSE stream transformer — ported from Antigravity-gateway
 * internal/synthetic/stream.go, adapted to Gemini chunk format:
 *   {"candidates":[{"index":0,"content":{"parts":[...]} or "finishReason":...}]}
 * Modes:
 *   - sideBufferBytes === 0: immediate pass-through of plain text (true streaming);
 *     if a synthetic tool call arrives later, the already-streamed text is flagged as conflict.
 *   - sideBufferBytes > 0: plain text is buffered and only flushed if the stream ends
 *     without a synthetic hit (prevents preamble leaks into the final answer).
 */
const { repairSyntheticArguments } = require("./repair");

function extractContentFromArgs(args, cfg) {
    if (args && typeof args === "object" && !Array.isArray(args)) {
        if (typeof args.content === "string") {
            return { content: args.content, repaired: false };
        }
        return { content: "", repaired: false };
    }
    if (typeof args === "string") {
        const res = repairSyntheticArguments(args, cfg.maxResponseBytes || 16 * 1024 * 1024);
        if (res.error || typeof res.content !== "string") {
            return { content: "", repaired: false };
        }
        return { content: res.content, repaired: true };
    }
    return { content: "", repaired: false };
}

function createStreamExtractor(cfg, toolName) {
    const stats = {
        conflict: false,
        realToolCount: 0,
        repaired: false,
        syntheticCount: 0,
        syntheticHit: false,
    };

    let bufferedText = [];
    let flushedPlainText = false;

    const remapFinishReason = chunk => {
        if (!chunk || !Array.isArray(chunk.candidates) || !chunk.candidates[0]) {
            return chunk;
        }
        const c0 = { ...chunk.candidates[0] };
        if (stats.syntheticHit && stats.realToolCount === 0 && c0.finishReason === "TOOL_CALLS") {
            c0.finishReason = "STOP";
            return { ...chunk, candidates: [c0] };
        }
        return chunk;
    };

    const flushBufferIntoFinishChunk = chunk => {
        const c0 = chunk.candidates[0];
        const content = {
            ...(c0.content || {}),
            parts: [...bufferedText],
            role: (c0.content && c0.content.role) || "model",
        };
        bufferedText = [];
        return { ...chunk, candidates: [{ ...c0, content }] };
    };

    return {
        finish() {
            if (bufferedText.length > 0) {
                if (stats.syntheticHit) {
                    bufferedText = [];
                    return null;
                }
                const flushed = {
                    candidates: [
                        {
                            content: { parts: [...bufferedText], role: "model" },
                            index: 0,
                        },
                    ],
                };
                bufferedText = [];
                return { data: flushed };
            }
            return null;
        },

        processChunk(chunk) {
            if (!chunk || !Array.isArray(chunk.candidates)) {
                // usage-only / promptFeedback chunk: pass through as-is
                return { data: chunk };
            }

            const c0 = chunk.candidates[0];
            const parts = c0 && c0.content && Array.isArray(c0.content.parts) ? c0.content.parts : null;

            if (!parts) {
                // finishReason / empty chunk
                let data = chunk;
                if (bufferedText.length > 0) {
                    if (stats.syntheticHit) {
                        bufferedText = [];
                    } else {
                        data = flushBufferIntoFinishChunk(chunk);
                    }
                }
                return { data: remapFinishReason(data) };
            }

            const outputParts = [];

            for (const part of parts) {
                if (!part) {
                    continue;
                }

                if (part.functionCall && part.functionCall.name === toolName) {
                    stats.syntheticHit = true;
                    stats.syntheticCount += 1;
                    if (bufferedText.length > 0) {
                        stats.conflict = true;
                        bufferedText = [];
                    }
                    if (flushedPlainText) {
                        stats.conflict = true;
                    }
                    const { content, repaired } = extractContentFromArgs(part.functionCall.args, cfg);
                    if (repaired) {
                        stats.repaired = true;
                    }
                    if (content) {
                        outputParts.push({ text: content });
                    }
                    continue;
                }

                if (part.functionCall) {
                    if (part.functionCall.name) {
                        stats.realToolCount += 1;
                        outputParts.push(part);
                        continue;
                    }
                    // Nameless continuation of an incrementally-streamed synthetic call
                    if (stats.syntheticHit) {
                        const { content, repaired } = extractContentFromArgs(part.functionCall.args, cfg);
                        if (repaired) {
                            stats.repaired = true;
                        }
                        if (content) {
                            outputParts.push({ text: content });
                        }
                        continue;
                    }
                    outputParts.push(part);
                    continue;
                }

                if (part.text && part.thought !== true) {
                    if (cfg.sideBufferBytes > 0) {
                        bufferedText.push(part);
                    } else {
                        flushedPlainText = true;
                        outputParts.push(part);
                    }
                    continue;
                }

                outputParts.push(part);
            }

            if (outputParts.length === 0) {
                return { data: null };
            }

            const content = {
                ...(c0.content || {}),
                parts: outputParts,
            };
            return { data: { ...chunk, candidates: [{ ...c0, content }] } };
        },

        stats,
    };
}

module.exports = { createStreamExtractor };
