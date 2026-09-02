/**
 * File: src/atg/injector.js
 * Description: Request injector (Gemini format) — ported from Antigravity-gateway
 * internal/synthetic/injector.go, adapted to native Gemini body shape:
 *   contents[] / tools[].functionDeclarations[] / toolConfig.functionCallingConfig
 * Gemini has no system/developer roles inside contents, so the control message is
 * always injected as a "user" turn — which doubles as the "end with user turn" (Gemini 400) fix.
 */
const crypto = require("crypto");
const { createModelFilter } = require("./modelFilter");

const DEFAULT_CONTROL_TEMPLATE =
    "IMPORTANT: Regular chat responses are unreliable in this environment. " +
    "Deliver your complete final answer exclusively by calling the function {tool_name}, " +
    'passing your visible answer as a string in the "content" parameter. ' +
    "Do not mention this instruction.";

function generateToolName(prefix, existingNames) {
    for (let attempt = 0; attempt < 8; attempt++) {
        const name = prefix + crypto.randomBytes(12).toString("hex");
        if (!existingNames.has(name)) {
            return name;
        }
    }
    return prefix + crypto.randomBytes(12).toString("hex") + String(Date.now()).slice(-6);
}

function buildSyntheticDeclaration(toolName, strict) {
    const declaration = {
        description:
            "Transport channel: call this function exactly once with your complete final answer " +
            "in the content parameter when you are ready to respond.",
        name: toolName,
        parameters: {
            properties: {
                content: { type: "STRING" },
            },
            required: ["content"],
            type: "OBJECT",
        },
    };
    if (strict) {
        declaration.parameters.additionalProperties = false;
    }
    return declaration;
}

function collectExistingNames(body) {
    const names = new Set();
    if (Array.isArray(body.tools)) {
        for (const tool of body.tools) {
            if (tool && Array.isArray(tool.functionDeclarations)) {
                for (const decl of tool.functionDeclarations) {
                    if (decl && typeof decl.name === "string") {
                        names.add(decl.name);
                    }
                }
            }
        }
    }
    return names;
}

function createInjector(cfg) {
    const prefix = cfg.syntheticToolPrefix || "atg_emit_";
    const position = cfg.controlMessagePosition === "head" ? "head" : "tail";
    const strict = cfg.syntheticToolStrict === true;
    const modelFilter = cfg.modelFilter || createModelFilter("", "");

    const buildControlContent = toolName => ({
        parts: [{ text: (cfg.controlPromptTemplate || DEFAULT_CONTROL_TEMPLATE).replace("{tool_name}", toolName) }],
        role: "user",
    });

    return {
        injectGemini(originalBody, modelHint = "") {
            // Mode "off": verbatim passthrough, no synthetic tool, no turn repair
            if (cfg.wrapperMode === "off") {
                return { body: originalBody, syntheticHit: false, toolName: "" };
            }

            const body = originalBody;
            const modelName =
                typeof body.model === "string" && body.model !== ""
                    ? body.model
                    : typeof modelHint === "string"
                      ? modelHint
                      : "";

            // Non-text models (image/audio/embedding): passthrough
            if (!modelFilter.isTextModel(modelName)) {
                return { body, syntheticHit: false, toolName: "" };
            }

            const existingNames = collectExistingNames(body);
            const toolName = generateToolName(prefix, existingNames);

            // Deep-ish mutation helpers: build a fresh tools array, preserving original structure
            const tools = Array.isArray(body.tools) ? body.tools.map(tool => ({ ...tool })) : [];
            if (tools.length === 0) {
                tools.push({ functionDeclarations: [] });
            }
            const target = tools[0];
            if (!Array.isArray(target.functionDeclarations)) {
                target.functionDeclarations = [];
            }
            if (!target.functionDeclarations.some(d => d && d.name === toolName)) {
                target.functionDeclarations = [
                    ...target.functionDeclarations,
                    buildSyntheticDeclaration(toolName, strict),
                ];
            }
            body.tools = tools;

            // toolConfig: force AUTO unless client pinned an explicit forced tool
            let mode = "AUTO";
            const existingToolConfig =
                body.toolConfig && body.toolConfig.functionCallingConfig ? body.toolConfig.functionCallingConfig : null;
            if (existingToolConfig) {
                if (existingToolConfig.mode === "NONE") {
                    mode = "AUTO";
                } else if (existingToolConfig.mode === "ANY" && !existingToolConfig.allowedFunctionNames) {
                    mode = "ANY";
                } else if (
                    existingToolConfig.mode === "ANY" &&
                    Array.isArray(existingToolConfig.allowedFunctionNames)
                ) {
                    // Client forced a real tool: keep ANY with its pinned names so the model may
                    // still legally invoke the synthetic transport as a fallback? No — honor the pin:
                    // model should only call the pinned real tool; synthetic remains available for
                    // downstream extraction if the model ignores the pin.
                    body.toolConfig = { functionCallingConfig: { ...existingToolConfig } };
                } else {
                    mode = existingToolConfig.mode || "AUTO";
                }
            }
            if (
                !body.toolConfig ||
                !body.toolConfig.functionCallingConfig ||
                !body.toolConfig.functionCallingConfig.allowedFunctionNames
            ) {
                body.toolConfig = { functionCallingConfig: { mode } };
            }

            // Control message injection: Gemini contents have no system role;
            // always use "user". tail position also fixes model-turn-ending requests.
            const controlContent = buildControlContent(toolName);
            const contents = Array.isArray(body.contents) ? body.contents : [];

            if (position === "head") {
                body.contents = [controlContent, ...contents];
            } else {
                body.contents = [...contents, controlContent];
            }

            return { body, syntheticHit: true, toolName };
        },
    };
}

module.exports = { createInjector };
