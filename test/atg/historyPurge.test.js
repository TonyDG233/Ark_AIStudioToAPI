/**
 * File: test/atg/historyPurge.test.js
 * Description: TDD contract for historyPurge.js — removes stale synthetic tool parts
 * from conversational history before re-injection (each request uses a fresh nonce,
 * so any previously injected atg_emit_* calls in history are stale).
 */
const { describe, test } = require("node:test");
const assert = require("node:assert");

const { purgeSyntheticHistory } = require("../../src/atg/historyPurge");
const { createInjector } = require("../../src/atg/injector");

describe("historyPurge.purgeSyntheticHistory", () => {
    const prefix = "atg_emit_";

    test("removes stale synthetic functionCall parts, keeps user-visible context intact", () => {
        const contents = [
            {
                parts: [{ text: "write a story" }],
                role: "user",
            },
            {
                parts: [{ functionCall: { args: { content: "Once upon a time..." }, name: "atg_emit_aaa111" } }],
                role: "model",
            },
            {
                parts: [{ functionResponse: { name: "atg_emit_aaa111", response: { content: "ok" } } }],
                role: "user",
            },
        ];

        const result = purgeSyntheticHistory(contents, prefix);
        assert.deepStrictEqual(
            result,
            [{ parts: [{ text: "write a story" }], role: "user" }],
            "stale synthetic parts removed AND emptied contents dropped (keeps context intact)"
        );
    });

    test("functionResponse-only part removed with prefix match", () => {
        const contents = [{ parts: [{ functionResponse: { name: "atg_emit_bbb222", response: {} } }], role: "user" }];
        const result = purgeSyntheticHistory(contents, prefix);
        assert.deepStrictEqual(result, [], "empty (purged) contents dropped entirely");
    });

    test("real tool calls and responses are preserved", () => {
        const contents = [
            {
                parts: [
                    { functionCall: { args: { query: "gemini" }, name: "web_search" } },
                    { functionCall: { args: { content: "stale" }, name: "atg_emit_ccc333" } },
                ],
                role: "model",
            },
            { parts: [{ functionResponse: { name: "web_search", response: { ok: true } } }], role: "user" },
        ];

        const result = purgeSyntheticHistory(contents, prefix);
        assert.deepStrictEqual(result, [
            { parts: [{ functionCall: { args: { query: "gemini" }, name: "web_search" } }], role: "model" },
            { parts: [{ functionResponse: { name: "web_search", response: { ok: true } } }], role: "user" },
        ]);
    });

    test("empty parts are dropped entirely (cleanup)", () => {
        const contents = [
            { parts: [], role: "model" },
            { parts: [{ text: "hi" }], role: "user" },
        ];
        const result = purgeSyntheticHistory(contents, prefix);
        assert.deepStrictEqual(result, [{ parts: [{ text: "hi" }], role: "user" }]);
    });

    test("integration: inject after purge produces clean conversation", () => {
        const inj = createInjector({ controlMessagePosition: "tail", syntheticToolPrefix: "atg_emit_" });
        const body = {
            contents: [
                { parts: [{ text: "again" }], role: "user" },
                { parts: [{ functionCall: { args: { content: "prev" }, name: "atg_emit_old123" } }], role: "model" },
                { parts: [{ functionResponse: { name: "atg_emit_old123", response: {} } }], role: "user" },
            ],
            model: "gemini-3.5-flash-low",
        };

        // Simulate pipeline: purge -> inject
        const purged = purgeSyntheticHistory(JSON.parse(JSON.stringify(body.contents)), "atg_emit_");
        const { body: out } = inj.injectGemini({ ...body, contents: purged });

        const allNames = JSON.stringify(out.tools).match(/atg_emit_[0-9a-f]{24}/g) || [];
        assert.strictEqual(allNames.length, 1, "exactly one synthetic tool (fresh)");
        assert.ok(!JSON.stringify(out.contents).includes("atg_emit_old123"), "stale tool call purged from history");
    });
});
