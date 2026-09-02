/**
 * File: test/antigravity/repair.test.js
 * Description: TDD contract for repair.js — ported from Antigravity-gateway internal/synthetic/repair_test.go
 */
const { describe, test } = require("node:test");
const assert = require("node:assert");

const { repairSyntheticArguments } = require("../../src/antigravity/repair");

describe("repairSyntheticArguments (contract from Go TestRepairSyntheticArguments)", () => {
    const cases = [
        {
            input: `{"content": "hello world"}`,
            name: "valid standard JSON",
            wantContent: "hello world",
            wantErr: false,
            wantRepair: false,
        },
        {
            input: '```json\n{"content": "fenced content"}\n```',
            name: "markdown code fence",
            wantContent: "fenced content",
            wantErr: false,
            wantRepair: true,
        },
        {
            input: `{"content": "unclosed text`,
            name: "unclosed quote and brace",
            wantContent: "unclosed text",
            wantErr: false,
            wantRepair: true,
        },
        {
            input: `{"content": "trailing",}`,
            name: "trailing comma",
            wantContent: "trailing",
            wantErr: false,
            wantRepair: true,
        },
        {
            input: '{"content": "line1\nline2\nline3"}',
            name: "raw unescaped newlines in string",
            wantContent: "line1\nline2\nline3",
            wantErr: false,
            wantRepair: true,
        },
        {
            input: `{"content": "Hello \\u4e16\\u754c"}`,
            name: "unicode escape in string",
            wantContent: "Hello 世界",
            wantErr: false,
            wantRepair: false,
        },
        {
            input: "",
            name: "empty string",
            wantContent: null,
            wantErr: true,
            wantRepair: false,
        },
        {
            input: `{"something_else": 123}`,
            name: "invalid non-content object",
            wantContent: null,
            wantErr: true,
            wantRepair: false,
        },
    ];

    for (const tc of cases) {
        test(tc.name, () => {
            const { content, repaired, error } = repairSyntheticArguments(tc.input, 1024 * 1024);
            if (tc.wantErr) {
                assert.ok(error, `expected error for input: ${tc.input}`);
                return;
            }
            assert.strictEqual(error, null, `unexpected error: ${error}`);
            assert.strictEqual(content, tc.wantContent);
            assert.strictEqual(repaired, tc.wantRepair);
        });
    }

    test("oversized arguments rejected", () => {
        const big = JSON.stringify({ content: "x".repeat(100) });
        const { error } = repairSyntheticArguments(big, 50);
        assert.ok(error);
    });

    test("content key variants accepted (scan fallback)", () => {
        const { content, repaired, error } = repairSyntheticArguments('{"answer": "scanned answer text', 1024 * 1024);
        assert.strictEqual(error, null);
        assert.strictEqual(content, "scanned answer text");
        assert.strictEqual(repaired, true);
    });
});
