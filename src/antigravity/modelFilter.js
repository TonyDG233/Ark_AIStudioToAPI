/**
 * File: src/antigravity/modelFilter.js
 * Description: Model classification filter — ported from Antigravity-gateway internal/synthetic/model_filter.go
 */
const DEFAULT_NON_TEXT_REGEX =
    /(image|vision-preview|audio|tts|stt|whisper|embed|embedding|video|flux|dall-e|sdxl|diffusion|moderation)/i;
const DEFAULT_TEXT_REGEX =
    /(gpt|claude|gemini|deepseek|qwen|llama|mistral|gemma|chat|text|instruct|reasoner|agent|plus|pro|flash|opus|sonnet|haiku|medium|low|high|lite|base|code|coder)/i;

function createModelFilter(customTextPattern, customNonTextPattern) {
    let textRegex = DEFAULT_TEXT_REGEX;
    let nonTextRegex = DEFAULT_NON_TEXT_REGEX;

    if (customTextPattern) {
        try {
            textRegex = new RegExp(customTextPattern);
        } catch (e) {
            // fall back to default
        }
    }

    if (customNonTextPattern) {
        try {
            nonTextRegex = new RegExp(customNonTextPattern);
        } catch (e) {
            // fall back to default
        }
    }

    return {
        isTextModel(modelName) {
            const trimmed = (modelName || "").trim();
            if (trimmed === "") {
                return false;
            }
            if (nonTextRegex && nonTextRegex.test(trimmed)) {
                return false;
            }
            if (textRegex && textRegex.test(trimmed)) {
                return true;
            }
            return true;
        },
    };
}

module.exports = { createModelFilter };
