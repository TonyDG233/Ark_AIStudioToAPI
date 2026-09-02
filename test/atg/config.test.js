/**
 * File: test/atg/config.test.js
 * Description: TDD contract for config.js (ATG_* environment variables)
 */
const { describe, test, afterEach } = require("node:test");
const assert = require("node:assert");

const { loadAtgConfig } = require("../../src/atg/config");

const SAVED = { ...process.env };

afterEach(() => {
    process.env = { ...SAVED };
    for (const key of Object.keys(process.env)) {
        if (key.startsWith("ATG_")) delete process.env[key];
    }
});

describe("loadAtgConfig", () => {
    test("defaults: mode off, no operation", () => {
        const cfg = loadAtgConfig({});
        assert.strictEqual(cfg.mode, "off");
        assert.strictEqual(cfg.toolPrefix, "atg_emit_");
        assert.strictEqual(cfg.controlPosition, "tail");
        assert.strictEqual(cfg.emptyRetries, 2);
        assert.strictEqual(cfg.recovery, "repair");
        assert.strictEqual(cfg.sideBufferBytes, 0);
        assert.strictEqual(cfg.enabled, false);
    });

    test("ATG_MODE=prefer enables the module", () => {
        process.env.ATG_MODE = "prefer";
        const cfg = loadAtgConfig({});
        assert.strictEqual(cfg.enabled, true);
        assert.strictEqual(cfg.mode, "prefer");
    });

    test("invalid ATG_MODE falls back to off with warning", () => {
        process.env.ATG_MODE = "always";
        const cfg = loadAtgConfig({});
        assert.strictEqual(cfg.enabled, false);
    });

    test("custom values honored", () => {
        process.env.ATG_MODE = "required";
        process.env.ATG_TOOL_PREFIX = "agw_xmit_";
        process.env.ATG_CONTROL_POSITION = "head";
        process.env.ATG_EMPTY_RETRIES = "0";
        process.env.ATG_RECOVERY = "fail";
        process.env.ATG_SIDE_BUFFER_BYTES = "0";
        const cfg = loadAtgConfig({});
        assert.strictEqual(cfg.mode, "required");
        assert.strictEqual(cfg.toolPrefix, "agw_xmit_");
        assert.strictEqual(cfg.controlPosition, "head");
        assert.strictEqual(cfg.emptyRetries, 0);
        assert.strictEqual(cfg.recovery, "fail");
        assert.strictEqual(cfg.sideBufferBytes, 0);
    });

    test("precedence: explicit config object over env", () => {
        process.env.ATG_MODE = "prefer";
        const cfg = loadAtgConfig({ mode: "off" });
        assert.strictEqual(cfg.mode, "off");
        assert.strictEqual(cfg.enabled, false);
    });

    test("non-text models skipped even in prefer mode", () => {
        process.env.ATG_MODE = "prefer";
        const cfg = loadAtgConfig({});
        assert.strictEqual(cfg.modelFilter.isTextModel("gemini-3.1-flash-image"), false);
        assert.strictEqual(cfg.modelFilter.isTextModel("gemini-3.5-flash-low"), true);
    });
});
