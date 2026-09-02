/**
 * File: test/antigravity/config.test.js
 * Description: TDD contract for config.js (AGW_* environment variables)
 */
const { describe, test, afterEach } = require("node:test");
const assert = require("node:assert");

const { loadAntigravityConfig } = require("../../src/antigravity/config");

const SAVED = { ...process.env };

afterEach(() => {
    process.env = { ...SAVED };
    for (const key of Object.keys(process.env)) {
        if (key.startsWith("AGW_")) delete process.env[key];
    }
});

describe("loadAntigravityConfig", () => {
    test("defaults: mode off, no operation", () => {
        const cfg = loadAntigravityConfig({});
        assert.strictEqual(cfg.mode, "off");
        assert.strictEqual(cfg.toolPrefix, "agw_emit_");
        assert.strictEqual(cfg.controlPosition, "tail");
        assert.strictEqual(cfg.emptyRetries, 2);
        assert.strictEqual(cfg.recovery, "repair");
        assert.strictEqual(cfg.sideBufferBytes, 0);
        assert.strictEqual(cfg.enabled, false);
    });

    test("AGW_MODE=prefer enables the module", () => {
        process.env.AGW_MODE = "prefer";
        const cfg = loadAntigravityConfig({});
        assert.strictEqual(cfg.enabled, true);
        assert.strictEqual(cfg.mode, "prefer");
    });

    test("invalid AGW_MODE falls back to off with warning", () => {
        process.env.AGW_MODE = "always";
        const cfg = loadAntigravityConfig({});
        assert.strictEqual(cfg.enabled, false);
    });

    test("custom values honored", () => {
        process.env.AGW_MODE = "required";
        process.env.AGW_TOOL_PREFIX = "agw_xmit_";
        process.env.AGW_CONTROL_POSITION = "head";
        process.env.AGW_EMPTY_RETRIES = "0";
        process.env.AGW_RECOVERY = "fail";
        process.env.AGW_SIDE_BUFFER_BYTES = "0";
        const cfg = loadAntigravityConfig({});
        assert.strictEqual(cfg.mode, "required");
        assert.strictEqual(cfg.toolPrefix, "agw_xmit_");
        assert.strictEqual(cfg.controlPosition, "head");
        assert.strictEqual(cfg.emptyRetries, 0);
        assert.strictEqual(cfg.recovery, "fail");
        assert.strictEqual(cfg.sideBufferBytes, 0);
    });

    test("precedence: explicit config object over env", () => {
        process.env.AGW_MODE = "prefer";
        const cfg = loadAntigravityConfig({ mode: "off" });
        assert.strictEqual(cfg.mode, "off");
        assert.strictEqual(cfg.enabled, false);
    });

    test("non-text models skipped even in prefer mode", () => {
        process.env.AGW_MODE = "prefer";
        const cfg = loadAntigravityConfig({});
        assert.strictEqual(cfg.modelFilter.isTextModel("gemini-3.1-flash-image"), false);
        assert.strictEqual(cfg.modelFilter.isTextModel("gemini-3.5-flash-low"), true);
    });
});
