/**
 * File: test/atg/extractor.test.js
 * Description: TDD contract for extractor.js non-streaming normalization (Gemini format)
 * Source contract: Antigravity-gateway internal/synthetic/normalizer_test.go
 * Adaptation: operates on native Gemini response (candidates[].content.parts[].functionCall)
 */
const { describe, test } = require("node:test");
const assert = require("node:assert");

const { createExtractor } = require("../../src/atg/extractor");
const { repairSyntheticArguments } = require("../../src/atg/repair");

const BASE_CFG = { maxResponseBytes: 1024 * 1024, wrapperMode: "prefer" };

function synthPart(name, content) {
    return { functionCall: { args: { content }, name } };
}

describe("extractor.normalizeNonStreaming (contract from Go TestNormalizeNonStreaming*)", () => {
    test("synthetic only: content extracted, tool call removed, finishReason TOOL_CALLS -> STOP", () => {
        const ex = createExtractor(BASE_CFG);
        const resp = {
            candidates: [
                {
                    content: { parts: [synthPart("atg_emit_test123", "This is the final response.")], role: "model" },
                    finishReason: "TOOL_CALLS",
                    index: 0,
                },
            ],
            id: "chatcmpl-123",
            model: "gemini-3.5-flash-low",
            usageMetadata: { totalTokenCount: 30 },
        };

        const { response, stats } = ex.normalizeNonStreaming(resp, "atg_emit_test123");

        assert.strictEqual(stats.syntheticHit, true);
        assert.strictEqual(stats.syntheticCount, 1);
        assert.strictEqual(stats.realToolCount, 0);

        const c0 = response.candidates[0];
        assert.deepStrictEqual(c0.content.parts, [{ text: "This is the final response." }]);
        assert.strictEqual(c0.finishReason, "STOP");
        assert.strictEqual(response.model, "gemini-3.5-flash-low", "model preserved verbatim");
        assert.ok(response.usageMetadata, "top-level metadata preserved");
    });

    test("mixed real + synthetic: synthetic -> text, real functionCall preserved, finishReason stays TOOL_CALLS", () => {
        const ex = createExtractor(BASE_CFG);
        const resp = {
            candidates: [
                {
                    content: {
                        parts: [
                            { functionCall: { args: { location: "Tokyo" }, name: "get_weather" } },
                            synthPart("atg_emit_abc", "Weather query result."),
                        ],
                        role: "model",
                    },
                    finishReason: "TOOL_CALLS",
                    index: 0,
                },
            ],
        };

        const { response, stats } = ex.normalizeNonStreaming(resp, "atg_emit_abc");

        assert.strictEqual(stats.realToolCount, 1);
        assert.strictEqual(stats.syntheticCount, 1);
        const parts = response.candidates[0].content.parts;
        assert.deepStrictEqual(
            parts[0],
            { functionCall: { args: { location: "Tokyo" }, name: "get_weather" } },
            "real tool call untouched"
        );
        assert.deepStrictEqual(parts[1], { text: "Weather query result." });
        assert.strictEqual(response.candidates[0].finishReason, "TOOL_CALLS");
    });

    test("content conflict: standard text discarded, never concatenated", () => {
        const ex = createExtractor(BASE_CFG);
        const resp = {
            candidates: [
                {
                    content: {
                        parts: [
                            { text: "Standard preamble text that should NOT be concatenated." },
                            synthPart("atg_emit_xyz", "The authoritative synthetic response."),
                        ],
                        role: "model",
                    },
                    finishReason: "TOOL_CALLS",
                    index: 0,
                },
            ],
        };

        const { response, stats } = ex.normalizeNonStreaming(resp, "atg_emit_xyz");

        assert.strictEqual(stats.conflict, true);
        const parts = response.candidates[0].content.parts;
        assert.deepStrictEqual(
            parts,
            [{ text: "The authoritative synthetic response." }],
            "must be ONLY the synthetic response"
        );
    });

    test("thought parts survive alongside synthetic extraction", () => {
        const ex = createExtractor(BASE_CFG);
        const resp = {
            candidates: [
                {
                    content: {
                        parts: [{ text: "thinking step", thought: true }, synthPart("atg_emit_t", "final")],
                        role: "model",
                    },
                    finishReason: "TOOL_CALLS",
                    index: 0,
                },
            ],
        };

        const { response } = ex.normalizeNonStreaming(resp, "atg_emit_t");
        const parts = response.candidates[0].content.parts;
        assert.deepStrictEqual(parts[0], { text: "thinking step", thought: true });
        assert.deepStrictEqual(parts[1], { text: "final" });
    });

    test("no synthetic hit + no tools: passthrough untouched", () => {
        const ex = createExtractor(BASE_CFG);
        const resp = {
            candidates: [{ content: { parts: [{ text: "plain" }], role: "model" }, finishReason: "STOP", index: 0 }],
        };
        const { response, stats } = ex.normalizeNonStreaming(resp, "atg_emit_unused");
        assert.strictEqual(stats.syntheticHit, false);
        assert.deepStrictEqual(response, resp);
    });

    test("required mode: error when synthetic call absent", () => {
        const ex = createExtractor({ ...BASE_CFG, wrapperMode: "required" });
        const resp = {
            candidates: [{ content: { parts: [{ text: "plain" }], role: "model" }, finishReason: "STOP", index: 0 }],
        };
        assert.throws(() => ex.normalizeNonStreaming(resp, "atg_emit_req"));
    });

    test("wrapperMode off: verbatim passthrough", () => {
        const ex = createExtractor({ ...BASE_CFG, wrapperMode: "off" });
        const resp = { candidates: [{ index: 0 }] };
        const { response } = ex.normalizeNonStreaming(resp, "");
        assert.deepStrictEqual(response, resp);
    });

    test("string-typed args (AI Studio quirk) repaired via repairSyntheticArguments", () => {
        const ex = createExtractor(BASE_CFG);
        const resp = {
            candidates: [
                {
                    content: {
                        parts: [{ functionCall: { args: '{"content": "repaired text"', name: "atg_emit_str" } }],
                        role: "model",
                    },
                    finishReason: "TOOL_CALLS",
                    index: 0,
                },
            ],
        };

        const { response, stats } = ex.normalizeNonStreaming(resp, "atg_emit_str");
        assert.strictEqual(stats.repaired, true);
        assert.deepStrictEqual(response.candidates[0].content.parts, [{ text: "repaired text" }]);
    });

    test("unrecoverable args + recovery=fail -> throws", () => {
        const ex = createExtractor({ ...BASE_CFG, recovery: "fail" });
        const resp = {
            candidates: [
                {
                    content: { parts: [{ functionCall: { args: null, name: "atg_emit_bad" } }], role: "model" },
                    finishReason: "TOOL_CALLS",
                    index: 0,
                },
            ],
        };
        assert.throws(() => ex.normalizeNonStreaming(resp, "atg_emit_bad"));
    });

    test("no candidates: passthrough untouched", () => {
        const ex = createExtractor(BASE_CFG);
        const resp = { promptFeedback: { blockReason: "SAFETY" } };
        const { response } = ex.normalizeNonStreaming(resp, "atg_emit_x");
        assert.deepStrictEqual(response, resp);
    });

    test("repairSyntheticArguments handles args with content + extras (keeps content only)", () => {
        const { content, error } = repairSyntheticArguments('{"content":"hi","extra":1}', 1024);
        assert.strictEqual(error, null);
        assert.strictEqual(content, "hi");
    });
});
