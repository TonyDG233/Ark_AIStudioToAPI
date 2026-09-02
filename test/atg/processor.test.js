/**
 * File: test/atg/processor.test.js
 * Description: TDD contract for the AntigravityProcessor facade (src/atg/index.js)
 */
const { describe, test, afterEach } = require("node:test");
const assert = require("node:assert");

const { createAtgProcessor } = require("../../src/atg/index");

afterEach(() => {
    for (const key of Object.keys(process.env)) {
        if (key.startsWith("ATG_")) delete process.env[key];
    }
});

describe("createAtgProcessor", () => {
    test("disabled by default: wrap/unwrap passthrough, no tool", () => {
        const proc = createAtgProcessor();
        assert.strictEqual(proc.enabled, false);

        const body = { contents: [{ parts: [{ text: "hi" }], role: "user" }], model: "gemini-3.5-flash-low" };
        const wrapped = proc.wrap(body);
        assert.strictEqual(wrapped.syntheticHit, false);
        assert.strictEqual(wrapped.toolName, "");
        assert.deepStrictEqual(wrapped.body, body);

        const unwrapped = proc.unwrapResponse({ candidates: [{ index: 0 }] }, "");
        assert.strictEqual(unwrapped.stats, null);
    });

    test("enabled: full wrap pipeline purges stale history then injects", () => {
        process.env.ATG_MODE = "prefer";
        const proc = createAtgProcessor();
        assert.strictEqual(proc.enabled, true);

        const body = {
            contents: [
                { parts: [{ text: "again" }], role: "user" },
                { parts: [{ functionCall: { args: {}, name: "atg_emit_stale" } }], role: "model" },
            ],
            model: "gemini-3.5-flash-low",
        };

        const wrapped = proc.wrap(body);
        assert.strictEqual(wrapped.syntheticHit, true);
        assert.ok(wrapped.toolName.startsWith("atg_emit_"));
        assert.ok(
            !JSON.stringify(wrapped.body.contents).includes("atg_emit_stale"),
            "stale synthetic history purged before injection"
        );
    });

    test("wrap and unwrap round-trip: synthetic tool call becomes plain text", () => {
        process.env.ATG_MODE = "prefer";
        const proc = createAtgProcessor();

        const body = { contents: [{ parts: [{ text: "hello" }], role: "user" }], model: "gemini-3.5-flash-low" };
        const { toolName } = proc.wrap(body);

        const upstream = {
            candidates: [
                {
                    content: {
                        parts: [{ functionCall: { args: { content: "round-trip answer" }, name: toolName } }],
                        role: "model",
                    },
                    finishReason: "TOOL_CALLS",
                    index: 0,
                },
            ],
        };

        const { response } = proc.unwrapResponse(upstream, toolName);
        assert.deepStrictEqual(response.candidates[0].content.parts, [{ text: "round-trip answer" }]);
        assert.strictEqual(response.candidates[0].finishReason, "STOP");
    });

    test("non-text model skips wrapping entirely", () => {
        process.env.ATG_MODE = "prefer";
        const proc = createAtgProcessor();

        const body = { contents: [{ parts: [{ text: "draw" }], role: "user" }], model: "gemini-3.1-flash-image" };
        const wrapped = proc.wrap(body);
        assert.strictEqual(wrapped.syntheticHit, false);
        assert.deepStrictEqual(wrapped.body, body);
    });

    test("Gemini body without top-level model field uses explicit model hint", () => {
        process.env.ATG_MODE = "prefer";
        const proc = createAtgProcessor();

        const body = {
            contents: [{ parts: [{ text: "hello" }], role: "user" }],
            generationConfig: { maxOutputTokens: 512 },
        };
        const wrapped = proc.wrap(body, "gemini-3.5-flash-low");
        assert.strictEqual(wrapped.syntheticHit, true, "text model via hint must be wrapped");
        assert.ok(wrapped.toolName.startsWith("atg_emit_"));

        const imageSkipped = proc.wrap({ ...body }, "gemini-3.1-flash-image");
        assert.strictEqual(imageSkipped.syntheticHit, false, "non-text model via hint must skip");
        assert.deepStrictEqual(imageSkipped.body, imageSkipped.body);
    });

    test("isSyntheticToolName guard", () => {
        process.env.ATG_MODE = "prefer";
        const proc = createAtgProcessor();
        assert.strictEqual(proc.isSyntheticToolName("atg_emit_abcd"), true);
        assert.strictEqual(proc.isSyntheticToolName("get_weather"), false);
        assert.strictEqual(proc.isSyntheticToolName(null), false);
    });
});
