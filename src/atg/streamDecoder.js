/**
 * File: src/atg/streamDecoder.js
 * Description: Incremental JSON string decoder — ported 1:1 from Antigravity-gateway
 * internal/synthetic/stream_decoder.go.
 * Operates on byte-stream semantics: feed chunks are treated as latin1-encoded bytes
 * (as in Go's []byte), and decoded output is emitted as UTF-8 text.
 */

const State = {
    Completed: 5,
    Error: 6,
    Init: 0,
    InString: 4,
    LookingForColon: 2,
    LookingForKey: 1,
    LookingForQuote: 3,
};

const CONTENT_KEYS = ['"content"', '"text"', '"answer"', '"response"', '"result"', '"output"', '"message"'];

const utf8Encode = s => Buffer.from(s, "utf8");
const utf8Decode = b => Buffer.from(b).toString("utf8");

function utf16IsHighSurrogate(r) {
    return r >= 0xd800 && r <= 0xdbff;
}

function utf16IsLowSurrogate(r) {
    return r >= 0xdc00 && r <= 0xdfff;
}

class IncrementalJSONStringDecoder {
    constructor() {
        this.state = State.Init;
        this.pendingEscape = [];
        this.pendingUTF8 = [];
        this.pendingKey = "";
        this.pendingQuote = false;
        this.surrogateHigh = 0;
        this.accumRaw = "";
        this.contentEmitted = false;
    }

    chunkToBytes(chunk) {
        const bytes = [];
        for (let i = 0; i < chunk.length; i++) {
            const code = chunk.charCodeAt(i);
            if (code <= 0xff) {
                bytes.push(code);
            } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < chunk.length) {
                const low = chunk.charCodeAt(i + 1);
                if (low >= 0xdc00 && low <= 0xdfff) {
                    bytes.push(...utf8Encode(String.fromCodePoint(chunk.codePointAt(i))));
                    i++;
                } else {
                    bytes.push(...utf8Encode(chunk[i]));
                }
            } else {
                bytes.push(...utf8Encode(chunk[i]));
            }
        }
        return bytes;
    }

    feed(chunk) {
        if (chunk === "") {
            return { done: this.state === State.Completed, output: "" };
        }

        this.accumRaw += chunk;

        const src = this.chunkToBytes(chunk);
        const out = [];
        let i = 0;

        while (i < src.length) {
            switch (this.state) {
                case State.Init: {
                    if (src[i] === 0x7b /* { */) {
                        this.state = State.LookingForKey;
                        i++;
                    } else if (src[i] === 0x22 /* " */) {
                        this.state = State.LookingForKey;
                        this.pendingKey += '"';
                        i++;
                    } else if (
                        src[i] === 0x20 ||
                        src[i] === 0x09 ||
                        src[i] === 0x0d ||
                        src[i] === 0x0a ||
                        src[i] === 0x60 /* ` */
                    ) {
                        i++;
                    } else {
                        this.state = State.InString;
                    }
                    break;
                }

                case State.LookingForKey: {
                    this.pendingKey += String.fromCharCode(src[i]);
                    i++;
                    const keyStr = this.pendingKey;
                    if (CONTENT_KEYS.some(k => keyStr.includes(k))) {
                        this.state = State.LookingForColon;
                        this.pendingKey = "";
                    } else if (keyStr.includes('":') || keyStr.includes('": ')) {
                        this.state = State.LookingForQuote;
                        this.pendingKey = "";
                    } else if (keyStr.length > 500) {
                        this.state = State.InString;
                    }
                    break;
                }

                case State.LookingForColon: {
                    if (src[i] === 0x3a /* : */) {
                        this.state = State.LookingForQuote;
                        i++;
                    } else if (src[i] === 0x20 || src[i] === 0x09 || src[i] === 0x0d || src[i] === 0x0a) {
                        i++;
                    } else if (src[i] === 0x22) {
                        this.state = State.InString;
                        i++;
                    } else {
                        this.state = State.InString;
                    }
                    break;
                }

                case State.LookingForQuote: {
                    if (src[i] === 0x22) {
                        this.state = State.InString;
                        i++;
                    } else if (src[i] === 0x20 || src[i] === 0x09 || src[i] === 0x0d || src[i] === 0x0a) {
                        i++;
                    } else {
                        this.state = State.InString;
                    }
                    break;
                }

                case State.InString: {
                    if (this.pendingQuote) {
                        this.pendingQuote = false;
                        const trimmedRemaining = String.fromCharCode(...src.slice(i)).replace(/^[ \t\r\n]+/, "");
                        if (trimmedRemaining.startsWith("}") || trimmedRemaining === "") {
                            this.state = State.Completed;
                            i = src.length;
                            break;
                        } else {
                            out.push(0x22);
                        }
                    }

                    let working = [];
                    if (this.pendingEscape.length > 0) {
                        working = this.pendingEscape.concat(src.slice(i));
                        this.pendingEscape = [];
                    } else if (this.pendingUTF8.length > 0) {
                        working = this.pendingUTF8.concat(src.slice(i));
                        this.pendingUTF8 = [];
                    } else {
                        working = src.slice(i);
                    }

                    let w = 0;
                    while (w < working.length) {
                        const b = working[w];

                        if (b === 0x5c /* \ */) {
                            if (w + 1 >= working.length) {
                                this.pendingEscape = working.slice(w);
                                i = src.length;
                                break;
                            }
                            const next = working[w + 1];
                            switch (next) {
                                case 0x22:
                                    out.push(0x22);
                                    w += 2;
                                    break;
                                case 0x5c:
                                    out.push(0x5c);
                                    w += 2;
                                    break;
                                case 0x2f:
                                    out.push(0x2f);
                                    w += 2;
                                    break;
                                case 0x62:
                                    out.push(0x08);
                                    w += 2;
                                    break;
                                case 0x66:
                                    out.push(0x0c);
                                    w += 2;
                                    break;
                                case 0x6e:
                                    out.push(0x0a);
                                    w += 2;
                                    break;
                                case 0x72:
                                    out.push(0x0d);
                                    w += 2;
                                    break;
                                case 0x74:
                                    out.push(0x09);
                                    w += 2;
                                    break;
                                case 0x75: {
                                    // \uXXXX
                                    if (w + 6 > working.length) {
                                        this.pendingEscape = working.slice(w);
                                        w = working.length;
                                        break;
                                    }
                                    const hexStr = String.fromCharCode(...working.slice(w + 2, w + 6));
                                    const u = parseInt(hexStr, 16);
                                    if (Number.isNaN(u)) {
                                        out.push(...utf8Encode("\\u" + hexStr));
                                    } else {
                                        const r = u;
                                        if (utf16IsHighSurrogate(r)) {
                                            this.surrogateHigh = r;
                                        } else if (utf16IsLowSurrogate(r) && this.surrogateHigh !== 0) {
                                            const combined =
                                                0x10000 + ((this.surrogateHigh - 0xd800) << 10) + (r - 0xdc00);
                                            out.push(...utf8Encode(String.fromCodePoint(combined)));
                                            this.surrogateHigh = 0;
                                        } else {
                                            out.push(...utf8Encode(String.fromCodePoint(r)));
                                        }
                                    }
                                    w += 6;
                                    break;
                                }
                                default:
                                    out.push(b, next);
                                    w += 2;
                            }
                        } else if (b === 0x22 /* " */) {
                            const remainingAfterQuote = working.slice(w + 1);
                            const trimmedRest = String.fromCharCode(...remainingAfterQuote).replace(/^[ \t\r\n]+/, "");

                            if (remainingAfterQuote.length === 0) {
                                this.pendingQuote = true;
                                w++;
                                i = src.length;
                                break;
                            } else if (trimmedRest.startsWith("}")) {
                                this.state = State.Completed;
                                w = working.length;
                                i = src.length;
                                break;
                            } else {
                                out.push(0x22);
                                w++;
                            }
                        } else if (b < 0x80) {
                            out.push(b);
                            w++;
                        } else {
                            // Multi-byte UTF-8 sequence
                            if (!isFullRune(working.slice(w))) {
                                this.pendingUTF8 = working.slice(w);
                                w = working.length;
                                break;
                            }
                            const rune = decodeRune(working.slice(w));
                            if (rune.error) {
                                out.push(b);
                                w++;
                            } else {
                                out.push(...utf8Encode(rune.char));
                                w += rune.size;
                            }
                        }
                    }
                    i = src.length;
                    break;
                }

                case State.Completed: {
                    const trimmed = src
                        .slice(i)
                        .map(c => String.fromCharCode(c))
                        .join("")
                        .trim();
                    if (trimmed !== "" && trimmed !== "}" && trimmed !== "}," && trimmed !== "}\n") {
                        this.state = State.InString;
                        break;
                    }
                    i = src.length;
                    break;
                }

                case State.Error:
                    i = src.length;
                    break;
            }
        }

        if (out.length > 0) {
            this.contentEmitted = true;
        }

        return { done: this.state === State.Completed, output: out.length > 0 ? utf8Decode(out) : "" };
    }

    finish(maxBytes) {
        const out = [];

        if (this.pendingQuote && !this.contentEmitted) {
            out.push(0x22);
            this.pendingQuote = false;
        }

        if (this.pendingEscape.length > 0) {
            out.push(...this.pendingEscape);
            this.pendingEscape = [];
        }
        if (this.pendingUTF8.length > 0) {
            out.push(...this.pendingUTF8);
            this.pendingUTF8 = [];
        }

        if (!this.contentEmitted && this.accumRaw !== "") {
            const { repairSyntheticArguments } = require("./repair");
            const res = repairSyntheticArguments(this.accumRaw, maxBytes);
            if (!res.error && res.content !== "") {
                return res.content;
            }
        }

        return out.length > 0 ? utf8Decode(out) : "";
    }
}

function isFullRune(bytes) {
    if (bytes.length === 0) return false;
    const b0 = bytes[0];
    if (b0 < 0x80) return true;
    if (b0 >= 0xc2 && b0 <= 0xdf) return bytes.length >= 2;
    if (b0 >= 0xe0 && b0 <= 0xef) return bytes.length >= 3;
    if (b0 >= 0xf0 && b0 <= 0xf4) return bytes.length >= 4;
    return true;
}

function decodeRune(bytes) {
    const b0 = bytes[0];
    if (b0 < 0x80) {
        return { char: String.fromCharCode(b0), error: false, size: 1 };
    }
    if (b0 >= 0xc2 && b0 <= 0xdf && bytes.length >= 2 && (bytes[1] & 0xc0) === 0x80) {
        const cp = ((b0 & 0x1f) << 6) | (bytes[1] & 0x3f);
        return { char: String.fromCharCode(cp), error: false, size: 2 };
    }
    if (b0 >= 0xe0 && b0 <= 0xef && bytes.length >= 3 && (bytes[1] & 0xc0) === 0x80 && (bytes[2] & 0xc0) === 0x80) {
        const cp = ((b0 & 0x0f) << 12) | ((bytes[1] & 0x3f) << 6) | (bytes[2] & 0x3f);
        return { char: String.fromCodePoint(cp), error: false, size: 3 };
    }
    if (
        b0 >= 0xf0 &&
        b0 <= 0xf4 &&
        bytes.length >= 4 &&
        (bytes[1] & 0xc0) === 0x80 &&
        (bytes[2] & 0xc0) === 0x80 &&
        (bytes[3] & 0xc0) === 0x80
    ) {
        const cp = ((b0 & 0x07) << 18) | ((bytes[1] & 0x3f) << 12) | ((bytes[2] & 0x3f) << 6) | (bytes[3] & 0x3f);
        return { char: String.fromCodePoint(cp), error: false, size: 4 };
    }
    return { char: "", error: true, size: 1 };
}

module.exports = { IncrementalJSONStringDecoder };
