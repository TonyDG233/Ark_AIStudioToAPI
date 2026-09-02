/**
 * File: src/antigravity/historyPurge.js
 * Description: Removes stale synthetic tool parts (functionCall/functionResponse with
 * AGW_TOOL_PREFIX names) from conversation history before fresh injection.
 * Rationale: each request generates a fresh nonce-based tool name, so any previously
 * injected synthetic calls in history are orphaned and must be purged.
 * Contents that end up with zero parts are dropped entirely (Gemini rejects empty parts).
 */
function purgeSyntheticHistory(contents, toolPrefix) {
    if (!Array.isArray(contents)) {
        return contents;
    }

    const kept = [];
    for (const content of contents) {
        if (!content || !Array.isArray(content.parts)) {
            kept.push(content);
            continue;
        }

        const parts = content.parts.filter(part => {
            if (!part) {
                return false;
            }
            if (part.functionCall && typeof part.functionCall.name === "string") {
                return !part.functionCall.name.startsWith(toolPrefix);
            }
            if (part.functionResponse && typeof part.functionResponse.name === "string") {
                return !part.functionResponse.name.startsWith(toolPrefix);
            }
            return true;
        });

        if (parts.length === 0) {
            continue;
        }

        kept.push({ ...content, parts });
    }

    return kept;
}

module.exports = { purgeSyntheticHistory };
