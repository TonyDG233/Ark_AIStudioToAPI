/**
 * File: test/antigravity/injector.test.js
 * Description: TDD contract for injector.js (Gemini-format adaptation)
 * Source contract: Antigravity-gateway internal/synthetic/injector_test.go
 * Adaptation: operates on native Gemini body (contents / tools[].functionDeclarations / toolConfig)
 * instead of OpenAI messages/tools — Gemini has no system/developer roles in contents.
 */
const { describe, test } = require("node:test");
const assert = require("node:assert");

const { createInjector } = require("../../src/antigravity/injector");

const BASE_CFG = {
    controlMessagePosition: "tail",
    syntheticToolPrefix: "agw_emit_",
    syntheticToolStrict: false,
    wrapperMode: "prefer",
};

describe("injector.injectGemini (contract from Go TestRequestInjector*)", () => {
    test("basic: synthetic tool injected, tail control user content appended", () => {
        const inj = createInjector(BASE_CFG);
        const body = {
            contents: [{ parts: [{ text: "hello" }], role: "user" }],
            model: "gemini-3.5-flash-low",
        };

        const { body: out, toolName, syntheticHit } = inj.injectGemini(body);

        assert.strictEqual(syntheticHit, true);
        assert.ok(toolName.startsWith("agw_emit_"));
        assert.strictEqual(toolName.length, "agw_emit_".length + 24, "96-bit nonce = 24 hex chars");

        assert.ok(Array.isArray(out.tools), "tools must exist");
        const declarations = out.tools[0].functionDeclarations;
        assert.strictEqual(declarations.length, 1);
        assert.strictEqual(declarations[0].name, toolName);
        assert.strictEqual(declarations[0].parameters.type, "OBJECT");
        assert.deepStrictEqual(declarations[0].parameters.properties.content, { type: "STRING" });
        assert.deepStrictEqual(declarations[0].parameters.required, ["content"]);

        assert.ok(out.contents.length === 2, "control message appended");
        const last = out.contents[out.contents.length - 1];
        assert.strictEqual(last.role, "user");
        assert.ok(last.parts[0].text.includes(toolName));

        assert.deepStrictEqual(out.toolConfig, { functionCallingConfig: { mode: "AUTO" } });
    });

    test("preserves real tools, appends synthetic; toolConfig NONE -> AUTO", () => {
        const inj = createInjector({ ...BASE_CFG, controlMessagePosition: "head" });
        const body = {
            contents: [{ parts: [{ text: "check weather" }], role: "user" }],
            model: "gemini-3.7-flash-high",
            toolConfig: { functionCallingConfig: { mode: "NONE" } },
            tools: [
                {
                    functionDeclarations: [
                        { description: "get weather", name: "get_weather", parameters: { type: "OBJECT" } },
                        { description: "calc", name: "calculate", parameters: { type: "OBJECT" } },
                    ],
                },
            ],
        };

        const { body: out, toolName } = inj.injectGemini(body);

        const declarations = out.tools[0].functionDeclarations;
        assert.strictEqual(declarations.length, 3, "2 real + 1 synthetic");
        assert.strictEqual(declarations[0].name, "get_weather");
        assert.strictEqual(declarations[1].name, "calculate");
        assert.strictEqual(declarations[2].name, toolName, "synthetic appended last");

        // head position: control message first
        assert.strictEqual(out.contents[0].role, "user");
        assert.ok(out.contents[0].parts[0].text.includes(toolName));

        // NONE forced off -> AUTO so the model may still pick the synthetic transport
        assert.deepStrictEqual(out.toolConfig, { functionCallingConfig: { mode: "AUTO" } });
    });

    test("wrapperMode off: verbatim passthrough (no synthetic tool)", () => {
        const inj = createInjector({ ...BASE_CFG, wrapperMode: "off" });
        const body = {
            contents: [{ parts: [{ text: "hi" }], role: "user" }],
            model: "gemini-3.5-flash-low",
        };

        const { body: out, toolName, syntheticHit } = inj.injectGemini(body);
        assert.strictEqual(syntheticHit, false);
        assert.strictEqual(toolName, "");
        assert.deepStrictEqual(out, body, "body must be untouched in off mode");
    });

    test("non-text model passthrough (verbatim, no tool)", () => {
        const inj = createInjector(BASE_CFG);
        const body = {
            contents: [{ parts: [{ text: "draw a cat" }], role: "user" }],
            model: "gemini-3.1-flash-image",
        };

        const { body: out, syntheticHit } = inj.injectGemini(body);
        assert.strictEqual(syntheticHit, false);
        assert.deepStrictEqual(out, body);
    });

    test("ends with model turn: control msg becomes user turn (Gemini 400 fix)", () => {
        const inj = createInjector(BASE_CFG);
        const body = {
            contents: [
                { parts: [{ text: "Write chapter 1" }], role: "user" },
                { parts: [{ text: "Chapter 1 outline..." }], role: "model" },
            ],
            model: "gemini-3.1-pro-low",
        };

        const { body: out, toolName } = inj.injectGemini(body);

        assert.strictEqual(out.contents.length, 3, "original 2 + control");
        const last = out.contents[out.contents.length - 1];
        assert.strictEqual(last.role, "user");
        assert.ok(last.parts[0].text.includes(toolName));
    });

    test("no contents at all: synthetic control message as only user turn", () => {
        const inj = createInjector(BASE_CFG);
        const body = { model: "gemini-3.1-pro-low" };

        const { body: out } = inj.injectGemini(body);
        assert.strictEqual(out.contents.length, 1);
        assert.strictEqual(out.contents[0].role, "user");
    });

    test("existing functionCall names avoided when generating unique tool name", () => {
        const inj = createInjector(BASE_CFG);
        const body = {
            contents: [{ parts: [{ text: "hi" }], role: "user" }],
            model: "gemini-3.5-flash-low",
            tools: [
                {
                    functionDeclarations: [
                        { name: "agw_emit_000000000000000000000000", parameters: { type: "OBJECT" } },
                    ],
                },
            ],
        };

        const { body: out, toolName } = inj.injectGemini(body);
        assert.notStrictEqual(toolName, "agw_emit_000000000000000000000000");
        const names = out.tools[0].functionDeclarations.map(d => d.name);
        assert.strictEqual(new Set(names).size, names.length, "no duplicate tool names");
    });

    test("stays byte-stable when already wrapped previously? no: new nonce each request (idempotence not required)", () => {
        // Sanity: injecting twice on same body yields different synthetic names (anti-collision property)
        const inj = createInjector(BASE_CFG);
        const body = {
            contents: [{ parts: [{ text: "hi" }], role: "user" }],
            model: "gemini-3.5-flash-low",
        };
        const a = inj.injectGemini(body);
        const b = inj.injectGemini(body);
        assert.notStrictEqual(a.toolName, b.toolName);
    });
});
