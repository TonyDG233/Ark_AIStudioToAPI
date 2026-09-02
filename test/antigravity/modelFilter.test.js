/**
 * File: test/antigravity/modelFilter.test.js
 * Description: TDD contract for modelFilter.js — ported from Antigravity-gateway internal/synthetic/model_filter_test.go
 */
const { describe, test } = require("node:test");
const assert = require("node:assert");

const { createModelFilter } = require("../../src/antigravity/modelFilter");

describe("modelFilter.IsTextModel (contract from Go TestModelFilterClassification)", () => {
    const filter = createModelFilter("", "");

    const textModels = [
        "gpt-4o",
        "gpt-4o-mini",
        "claude-3-5-sonnet-20241022",
        "claude-opus-4-6-thinking",
        "gemini-3.5-flash-low",
        "gemini-3.7-flash-high",
        "deepseek-chat",
        "deepseek-reasoner",
        "qwen-2.5-72b-instruct",
        "llama-3.3-70b-instruct",
        "gpt-oss-120b-medium",
    ];

    const nonTextModels = [
        "gemini-3.1-flash-image",
        "dall-e-3",
        "text-embedding-3-small",
        "text-embedding-ada-002",
        "whisper-1",
        "tts-1",
        "tts-1-hd",
        "flux-schnell",
        "sdxl-turbo",
        "stable-diffusion-3",
        "omni-moderation-latest",
    ];

    for (const model of textModels) {
        test(`${model} -> text model`, () => {
            assert.strictEqual(filter.isTextModel(model), true);
        });
    }

    for (const model of nonTextModels) {
        test(`${model} -> non-text model`, () => {
            assert.strictEqual(filter.isTextModel(model), false);
        });
    }

    test("empty model name -> false", () => {
        assert.strictEqual(filter.isTextModel(""), false);
        assert.strictEqual(filter.isTextModel("   "), false);
    });

    test("unknown alphanumeric id falls back to text model (Go step 3)", () => {
        assert.strictEqual(filter.isTextModel("random-xyz-123"), true);
    });

    test("custom patterns override defaults", () => {
        const custom = createModelFilter("^(my-model|other)-", "^(.*)-(nope)$");
        assert.strictEqual(custom.isTextModel("my-model-1"), true);
        assert.strictEqual(custom.isTextModel("other-2"), true);
        assert.strictEqual(custom.isTextModel("image-x-nope"), false);
    });
});
