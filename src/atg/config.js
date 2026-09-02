/**
 * File: src/atg/config.js
 * Description: ATG_* environment configuration loader. Precedence: explicit
 * overrides object > environment variables > defaults. Mode "off" disables the
 * module entirely (zero behavioral change to the pipeline).
 */
const { createModelFilter } = require("./modelFilter");

const DEFAULTS = {
    controlPosition: "tail",
    emptyRetries: 2,
    maxResponseBytes: 16 * 1024 * 1024,
    mode: "off",
    recovery: "repair",
    sideBufferBytes: 0,
    syntheticToolStrict: false,
    toolPrefix: "atg_emit_",
};

function readEnv(name) {
    return process.env[name];
}

function parseMode(value) {
    const v = String(value || "").toLowerCase();
    if (v === "prefer" || v === "required") {
        return v;
    }
    if (v === "" || v === "off") {
        return "off";
    }
    return "off";
}

function parseBoundedInt(value, fallback, min, max) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, n));
}

function loadAtgConfig(overrides = {}) {
    const env = {
        controlPosition: readEnv("ATG_CONTROL_POSITION") === "head" ? "head" : "tail",
        emptyRetries: parseBoundedInt(readEnv("ATG_EMPTY_RETRIES"), DEFAULTS.emptyRetries, 0, 5),
        maxResponseBytes: parseBoundedInt(
            readEnv("ATG_MAX_RESPONSE_BYTES"),
            DEFAULTS.maxResponseBytes,
            1024,
            100 * 1024 * 1024
        ),
        mode: parseMode(readEnv("ATG_MODE")),
        recovery: readEnv("ATG_RECOVERY") === "fail" ? "fail" : "repair",
        sideBufferBytes: parseBoundedInt(
            readEnv("ATG_SIDE_BUFFER_BYTES"),
            DEFAULTS.sideBufferBytes,
            0,
            16 * 1024 * 1024
        ),
        syntheticToolStrict: String(readEnv("ATG_TOOL_STRICT") || "").toLowerCase() === "true",
        toolPrefix: String((readEnv("ATG_TOOL_PREFIX") || DEFAULTS.toolPrefix).trim()),
    };

    const cfg = { ...DEFAULTS, ...env, ...overrides };

    cfg.enabled = cfg.mode !== "off";
    cfg.modelFilter =
        overrides.modelFilter ||
        createModelFilter(readEnv("ATG_TEXT_MODEL_PATTERN"), readEnv("ATG_NON_TEXT_MODEL_PATTERN"));

    return cfg;
}

module.exports = { loadAtgConfig };
