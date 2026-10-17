/**
 * File: test/atg/clientPatterns.test.js
 * Description: Contract tests for the client-side synthetic transport detector
 * and its integration in the injector (ATG_CLIENT_SYNTHETIC_GUARD, default on).
 */
const { describe, test } = require("node:test");
const assert = require("node:assert");

const { detectClientSyntheticTransport } = require("../../src/atg/clientPatterns");
const { createInjector } = require("../../src/atg/injector");

const contentDeclaration = (name, description) => ({
    description,
    name,
    parameters: {
        properties: { content: { type: "STRING" } },
        required: ["content"],
        type: "OBJECT",
    },
});

const userTurn = text => ({ parts: [{ text }], role: "user" });

describe("clientPatterns.detectClientSyntheticTransport", () => {
    test("prefixed tool name (atg_emit_*) is detected", () => {
        const body = {
            contents: [userTurn("hi")],
            tools: [{ functionDeclarations: [contentDeclaration("atg_emit_deadbeef", "transport channel")] }],
        };
        const hit = detectClientSyntheticTransport(body, "atg_emit_");
        assert.strictEqual(hit.hit, true);
        assert.strictEqual(hit.reason, "prefixed-name");
        assert.strictEqual(hit.name, "atg_emit_deadbeef");
    });

    test("answer-intent description with content parameter is detected", () => {
        const body = {
            contents: [userTurn("hi")],
            tools: [
                {
                    functionDeclarations: [
                        contentDeclaration(
                            "emit_reply",
                            "Deliver your complete final answer by calling this function with the content parameter."
                        ),
                    ],
                },
            ],
        };
        const hit = detectClientSyntheticTransport(body);
        assert.strictEqual(hit.hit, true);
        assert.strictEqual(hit.reason, "declaration-intent");
        assert.strictEqual(hit.name, "emit_reply");
    });

    test("content-shaped tool force-pinned via toolConfig is detected", () => {
        const body = {
            contents: [userTurn("hi")],
            toolConfig: { functionCallingConfig: { allowedFunctionNames: ["relay_answer"], mode: "ANY" } },
            tools: [{ functionDeclarations: [contentDeclaration("relay_answer", "some transport tool")] }],
        };
        const hit = detectClientSyntheticTransport(body);
        assert.strictEqual(hit.hit, true);
        assert.strictEqual(hit.reason, "forced-content-tool");
        assert.strictEqual(hit.name, "relay_answer");
    });

    test("history loop evidence (call + functionResponse for the same tool) is detected", () => {
        const body = {
            contents: [
                userTurn("hi"),
                { parts: [{ functionCall: { args: { content: "x" }, name: "respond_via_tool" } }], role: "model" },
                { parts: [{ functionResponse: { name: "respond_via_tool", response: { ok: true } } }], role: "user" },
            ],
            tools: [{ functionDeclarations: [contentDeclaration("respond_via_tool", "plain transport")] }],
        };
        const hit = detectClientSyntheticTransport(body);
        assert.strictEqual(hit.hit, true);
        assert.strictEqual(hit.reason, "history-loop");
        assert.strictEqual(hit.name, "respond_via_tool");
    });

    test("control-instruction phrasing without tools is detected", () => {
        const body = {
            contents: [userTurn("hi")],
            systemInstruction: {
                parts: [
                    {
                        text: "You must deliver your complete final answer by calling the function foo and passing it in the content field.",
                    },
                ],
            },
        };
        const hit = detectClientSyntheticTransport(body);
        assert.strictEqual(hit.hit, true);
        assert.strictEqual(hit.reason, "instruction-pattern");
        assert.strictEqual(hit.name, "");
    });

    test("normal client tools do not trigger the detector", () => {
        const body = {
            contents: [userTurn("weather in tokyo?")],
            tools: [
                {
                    functionDeclarations: [
                        {
                            description: "Get the current weather for a location.",
                            name: "get_weather",
                            parameters: {
                                properties: { location: { type: "STRING" } },
                                required: ["location"],
                                type: "OBJECT",
                            },
                        },
                    ],
                },
            ],
        };
        const hit = detectClientSyntheticTransport(body);
        assert.ok(!hit || hit.hit === false, "normal tools must not be flagged as synthetic");
        if (hit) {
            assert.deepStrictEqual(hit.tools, ["get_weather"]);
        }
    });

    test("empty or tool-less bodies return null", () => {
        assert.strictEqual(detectClientSyntheticTransport(null), null);
        assert.strictEqual(detectClientSyntheticTransport({}), null);
        assert.strictEqual(detectClientSyntheticTransport({ contents: [userTurn("plain chat")] }), null);
    });
});

describe("injector clientSyntheticGuard integration", () => {
    const baseCfg = {
        clientSyntheticGuard: true,
        controlMessagePosition: "tail",
        syntheticToolPrefix: "atg_emit_",
        syntheticToolStrict: false,
        wrapperMode: "prefer",
    };

    test("guard hit: local wrap skipped, no local tool injected", () => {
        const injector = createInjector(baseCfg);
        const body = {
            contents: [userTurn("hi")],
            model: "gemini-3.8-flash",
            tools: [
                {
                    functionDeclarations: [
                        contentDeclaration(
                            "emit_reply",
                            "Deliver your complete final answer by calling this function."
                        ),
                    ],
                },
            ],
        };
        const result = injector.injectGemini(body, "gemini-3.8-flash");
        assert.strictEqual(result.toolName, "");
        assert.strictEqual(result.syntheticHit, false);
        assert.strictEqual(result.clientSynthetic.hit, true);
        const names = () => result.body.tools.flatMap(t => t.functionDeclarations.map(d => d.name));
        assert.ok(!names().some(n => n.startsWith("atg_emit_")), "no local synthetic tool may be added");
        assert.strictEqual(result.body.toolConfig, undefined, "toolConfig must not be rewritten on skip");
        assert.strictEqual(result.body.contents.length, 1, "no control message may be appended on skip");
    });

    test("no client mechanism: local tool injected as before", () => {
        const injector = createInjector(baseCfg);
        const body = { contents: [userTurn("hi")], model: "gemini-3.8-flash" };
        const result = injector.injectGemini(body, "gemini-3.8-flash");
        assert.ok(result.toolName.startsWith("atg_emit_"), "local synthetic tool must be injected");
        assert.strictEqual(result.syntheticHit, true);
        const names = result.body.tools.flatMap(t => t.functionDeclarations.map(d => d.name));
        assert.ok(names.includes(result.toolName));
    });

    test("guard disabled: wrap proceeds even with client synthetic tool", () => {
        const injector = createInjector({ ...baseCfg, clientSyntheticGuard: false });
        const body = {
            contents: [userTurn("hi")],
            model: "gemini-3.8-flash",
            tools: [
                {
                    functionDeclarations: [
                        contentDeclaration(
                            "emit_reply",
                            "Deliver your complete final answer by calling this function."
                        ),
                    ],
                },
            ],
        };
        const result = injector.injectGemini(body, "gemini-3.8-flash");
        assert.ok(result.toolName.startsWith("atg_emit_"));
        assert.strictEqual(result.syntheticHit, true);
    });

    test("near miss: declared client tools are surfaced without a hit", () => {
        const injector = createInjector(baseCfg);
        const body = {
            contents: [userTurn("hi")],
            model: "gemini-3.8-flash",
            tools: [
                {
                    functionDeclarations: [
                        {
                            description: "Get current weather.",
                            name: "get_weather",
                            parameters: { properties: { location: { type: "STRING" } }, type: "OBJECT" },
                        },
                    ],
                },
            ],
        };
        const result = injector.injectGemini(body, "gemini-3.8-flash");
        assert.ok(result.toolName.startsWith("atg_emit_"));
        assert.deepStrictEqual(result.clientTools, ["get_weather"]);
    });
});
