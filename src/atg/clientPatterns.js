/**
 * File: src/atg/clientPatterns.js
 * Description: Client-side synthetic transport detector. Scans an incoming
 * native Gemini request for signs that the CLIENT already ships a similar
 * answer-via-tool-call bypass mechanism (Tavern anti-truncation extensions and
 * the like). When detected, the local ATG wrap is skipped for that request so
 * two synthetic transports never stack.
 *
 * Signals, extracted from tool calls first and foremost:
 *   1. a declared tool whose name uses the local synthetic prefix (atg_emit_*)
 *   2. a declared tool with answer/response intent in its description plus a
 *      content-like STRING parameter
 *   3. a tool force-pinned via toolConfig.functionCallingConfig.allowedFunctionNames
 *      that also carries the content-like shape
 *   4. history evidence: the same content-shaped tool already called by the
 *      model and answered via functionResponse inside body.contents
 *   5. control-instruction phrasing ("deliver your complete final answer ...")
 *      anywhere in systemInstruction or the recent text parts
 */

const CONTENT_PARAM_NAMES = new Set([
    "answer",
    "body",
    "content",
    "final",
    "message",
    "output",
    "reply",
    "response",
    "text",
]);

const DECLARATION_DESC_PATTERN =
    /(complete|final|entire|whole)[\s\S]{0,60}?(answer|response|reply|output)|(call|invoke|use)[\s\S]{0,50}?(function|tool)[\s\S]{0,60}?(content|answer|response)|(answer|response|reply)[\s\S]{0,40}?via[\s\S]{0,20}?(tool|function)/i;

const TOOL_NAME_PATTERN =
    /(emit|deliver|transport|bypass|relay|output|respond|reply|answer|say|speak|send|write|final)/i;

const INSTRUCTION_PATTERN =
    /(deliver|provide|give|output|write|put)[\s\S]{0,80}?(complete|final|entire|whole)[\s\S]{0,40}?(answer|response|reply|text)|(call|invoke)[\s\S]{0,80}?(function|tool)[\s\S]{0,80}?(content|answer)/i;

const MAX_SCANNED_PARTS = 60;
const MAX_SCANNED_TEXT = 4000;

function collectDeclarations(body) {
    const declarations = [];
    if (!body || !Array.isArray(body.tools)) {
        return declarations;
    }
    for (const tool of body.tools) {
        if (!tool || !Array.isArray(tool.functionDeclarations)) {
            continue;
        }
        for (const declaration of tool.functionDeclarations) {
            if (declaration && typeof declaration.name === "string") {
                declarations.push(declaration);
            }
        }
    }
    return declarations;
}

function declarationShape(declaration) {
    const properties =
        declaration.parameters &&
        declaration.parameters.properties &&
        typeof declaration.parameters.properties === "object"
            ? Object.keys(declaration.parameters.properties)
            : [];
    const required = Array.isArray(declaration.parameters && declaration.parameters.required)
        ? declaration.parameters.required
        : [];
    const contentParamNames = properties.filter(name => CONTENT_PARAM_NAMES.has(String(name).toLowerCase()));
    return {
        contentParam: contentParamNames.length > 0,
        contentParamRequired: contentParamNames.some(name => required.map(String).includes(name)),
        description: typeof declaration.description === "string" ? declaration.description : "",
        nameHit: TOOL_NAME_PATTERN.test(declaration.name),
    };
}

/**
 * @returns {null | {hit: boolean, name: string, reason: string, tools?: string[]}}
 */
function detectClientSyntheticTransport(body, prefix = "atg_emit_") {
    if (!body || typeof body !== "object") {
        return null;
    }
    const declarations = collectDeclarations(body);
    const toolNames = declarations.map(d => d.name).slice(0, 8);
    const makeHit = (name, reason) => ({ hit: true, name: name || "", reason, tools: toolNames });

    // 1. Local synthetic prefix declared by the client itself.
    for (const declaration of declarations) {
        if (declaration.name.startsWith(prefix)) {
            return makeHit(declaration.name, "prefixed-name");
        }
    }

    const forcedNames = (() => {
        const config = body.toolConfig && body.toolConfig.functionCallingConfig;
        return config && Array.isArray(config.allowedFunctionNames) ? config.allowedFunctionNames.map(String) : [];
    })();

    // 2/3. Answer-intent declaration or a forced content-shaped tool.
    for (const declaration of declarations) {
        const shape = declarationShape(declaration);
        const descHit = shape.description.length > 0 && DECLARATION_DESC_PATTERN.test(shape.description);
        const forcedHit = forcedNames.includes(declaration.name);
        if (shape.contentParam && descHit) {
            return makeHit(declaration.name, "declaration-intent");
        }
        if (shape.contentParam && shape.nameHit && forcedHit) {
            return makeHit(declaration.name, "forced-content-tool");
        }
    }

    // 4. History evidence: the content-shaped tool was already called and answered
    //    inside contents (the client runs its own synthetic loop).
    if (Array.isArray(body.contents) && declarations.length > 0) {
        const calledNames = new Set();
        const answeredNames = new Set();
        for (const content of body.contents) {
            if (!content || !Array.isArray(content.parts)) {
                continue;
            }
            for (const part of content.parts) {
                if (part && part.functionCall && typeof part.functionCall.name === "string") {
                    calledNames.add(part.functionCall.name);
                }
                if (part && part.functionResponse && typeof part.functionResponse.name === "string") {
                    answeredNames.add(part.functionResponse.name);
                }
            }
        }
        for (const declaration of declarations) {
            if (!calledNames.has(declaration.name) || !answeredNames.has(declaration.name)) {
                continue;
            }
            const shape = declarationShape(declaration);
            if (shape.contentParam && shape.nameHit) {
                return makeHit(declaration.name, "history-loop");
            }
        }
    }

    // 5. Control-instruction phrasing in system instruction or recent text parts.
    const texts = [];
    if (body.systemInstruction && Array.isArray(body.systemInstruction.parts)) {
        for (const part of body.systemInstruction.parts) {
            if (part && typeof part.text === "string") {
                texts.push(part.text);
            }
        }
    }
    if (Array.isArray(body.contents)) {
        let scanned = 0;
        for (const content of body.contents) {
            if (!content || !Array.isArray(content.parts)) {
                continue;
            }
            for (const part of content.parts) {
                if (scanned++ >= MAX_SCANNED_PARTS) {
                    break;
                }
                if (part && typeof part.text === "string") {
                    texts.push(part.text);
                }
            }
        }
    }
    let scannedChars = 0;
    for (const text of texts) {
        if (scannedChars >= MAX_SCANNED_TEXT) {
            break;
        }
        scannedChars += text.length;
        if (INSTRUCTION_PATTERN.test(text)) {
            return makeHit("", "instruction-pattern");
        }
    }

    if (declarations.length > 0) {
        // No hit, but the client declared tools: surface their names at debug level
        // so an unrecognized client-side mechanism can be identified from logs.
        return { hit: false, name: "", reason: "declared-tools-present", tools: toolNames };
    }
    return null;
}

module.exports = { detectClientSyntheticTransport };
