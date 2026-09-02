/**
 * File: src/antigravity/repair.js
 * Description: Deterministic repair of synthetic tool arguments — ported from
 * Antigravity-gateway internal/synthetic/repair.go
 */

const ARGUMENT_KEYS = ["content", "text", "answer", "response", "result", "output", "message"];

function repairSyntheticArguments(rawArgs, maxBytes) {
    if (typeof rawArgs !== "string" || rawArgs.length > maxBytes) {
        return { content: null, error: new Error("arguments exceed maximum allowed size"), repaired: false };
    }

    const trimmed = rawArgs.trim();
    if (trimmed === "") {
        return { content: null, error: new Error("arguments decode failed"), repaired: false };
    }

    // 1. Fast path: standard json parse
    const fast = parseContentJson(trimmed);
    if (fast.ok) {
        return { content: fast.content, error: null, repaired: false };
    }

    // 2. Strip Markdown code fences: e.g. ```json ... ```
    const cleaned = stripMarkdownCodeFences(trimmed);

    const fenced = parseContentJson(cleaned);
    if (fenced.ok) {
        return { content: fenced.content, error: null, repaired: true };
    }

    // 3. Structural repair: fix unclosed strings, trailing commas, missing closing braces
    const repairedJSON = attemptStructuralRepair(cleaned);
    const repaired = parseContentJson(repairedJSON);
    if (repaired.ok) {
        return { content: repaired.content, error: null, repaired: true };
    }

    // 4. Bounded scanner fallback for content-ish fields
    const scanned = scanAndExtractContent(cleaned);
    if (scanned.ok) {
        return { content: scanned.content, error: null, repaired: true };
    }

    return { content: null, error: new Error("synthetic tool arguments decode failed"), repaired: false };
}

function parseContentJson(s) {
    try {
        const obj = JSON.parse(s);
        if (obj && typeof obj === "object" && typeof obj.content === "string") {
            return { content: obj.content, ok: true };
        }
        return { ok: false };
    } catch (e) {
        return { ok: false };
    }
}

function stripMarkdownCodeFences(s) {
    let out = s.trim();
    if (out.startsWith("```")) {
        const firstNewline = out.indexOf("\n");
        if (firstNewline !== -1) {
            out = out.slice(firstNewline + 1);
        } else {
            out = out.replace(/^```+/, "");
        }
        const closeIdx = out.lastIndexOf("```");
        if (closeIdx !== -1) {
            out = out.slice(0, closeIdx);
        }
        out = out.trim();
    }
    return out;
}

function attemptStructuralRepair(s) {
    let out = s.trim();
    if (!out.startsWith("{")) {
        const idx = out.indexOf("{");
        if (idx !== -1) {
            out = out.slice(idx);
        } else {
            return out;
        }
    }

    let result = "";
    let inString = false;
    let escaped = false;
    let openBraces = 0;
    let openBrackets = 0;

    for (let i = 0; i < out.length; i++) {
        const b = out[i];
        if (inString) {
            if (escaped) {
                escaped = false;
                result += b;
            } else if (b === "\\") {
                escaped = true;
                result += b;
            } else if (b === '"') {
                inString = false;
                result += b;
            } else if (b === "\n" || b === "\r" || b === "\t") {
                if (b === "\n") result += "\\n";
                else if (b === "\r") result += "\\r";
                else result += "\\t";
            } else {
                result += b;
            }
        } else {
            if (b === '"') {
                inString = true;
                result += b;
            } else if (b === "{") {
                openBraces++;
                result += b;
            } else if (b === "}") {
                if (openBraces > 0) {
                    openBraces--;
                    result += b;
                }
            } else if (b === "[") {
                openBrackets++;
                result += b;
            } else if (b === "]") {
                if (openBrackets > 0) {
                    openBrackets--;
                    result += b;
                }
            } else {
                result += b;
            }
        }
    }

    if (inString) {
        result += '"';
    }

    result = result.replace(/[\s,]+$/, "");

    while (openBrackets > 0) {
        result += "]";
        openBrackets--;
    }
    while (openBraces > 0) {
        result += "}";
        openBraces--;
    }

    return result;
}

function scanAndExtractContent(s) {
    for (const key of ARGUMENT_KEYS) {
        const keyIdx = s.indexOf(`"${key}"`);
        if (keyIdx === -1) {
            continue;
        }
        let sub = s.slice(keyIdx + key.length + 2);
        const colonIdx = sub.indexOf(":");
        if (colonIdx === -1) {
            continue;
        }
        sub = sub.slice(colonIdx + 1).trim();
        if (!sub.startsWith('"')) {
            continue;
        }

        let valBuf = "";
        let escaped = false;
        let started = false;

        for (let i = 0; i < sub.length; i++) {
            const b = sub[i];
            if (!started) {
                if (b === '"') {
                    started = true;
                }
                continue;
            }

            if (escaped) {
                escaped = false;
                switch (b) {
                    case '"':
                    case "\\":
                    case "/":
                        valBuf += b;
                        break;
                    case "b":
                        valBuf += "\b";
                        break;
                    case "f":
                        valBuf += "\f";
                        break;
                    case "n":
                        valBuf += "\n";
                        break;
                    case "r":
                        valBuf += "\r";
                        break;
                    case "t":
                        valBuf += "\t";
                        break;
                    case "u": {
                        const hexStr = sub.slice(i + 1, i + 5);
                        const u = parseInt(hexStr, 16);
                        if (Number.isFinite(u)) {
                            valBuf += String.fromCharCode(u);
                            i += 4;
                            continue;
                        }
                        valBuf += "\\u";
                        break;
                    }
                    default:
                        valBuf += b;
                }
            } else if (b === "\\") {
                escaped = true;
            } else if (b === '"') {
                const rest = sub.slice(i + 1).trimStart();
                if (rest === "" || rest.startsWith("}") || rest.startsWith(",")) {
                    return { content: valBuf, ok: true };
                }
                valBuf += '"';
            } else {
                valBuf += b;
            }
        }

        if (valBuf.length > 0) {
            return { content: valBuf, ok: true };
        }
    }

    return { content: "", ok: false };
}

module.exports = { repairSyntheticArguments };
