/**
 * File: test/antigravity/streamExtractor.test.js
 * Description: TDD contract for streamDecoder.js (incremental JSON string) + streamExtractor.js
 *   (per-chunk Gemini SSE transformer)
 * Source contract: Antigravity-gateway internal/synthetic/stream_test.go + stream_decoder.go
 * Adaptation: operates on Gemini SSE chunk JSON instead of OpenAI chunk JSON
 */
const { describe, test } = require("node:test");
const assert = require("node:assert");

const { IncrementalJSONStringDecoder } = require("../../src/antigravity/streamDecoder");
const { createStreamExtractor } = require("../../src/antigravity/streamExtractor");

const BASE_CFG = { maxResponseBytes: 1024 * 1024, sideBufferBytes: 0, wrapperMode: "prefer" };

describe("IncrementalJSONStringDecoder (contract from Go TestIncrementalJSON*)", () => {
    function feedAll(decoder, chunks) {
        let emitted = "";
        for (const c of chunks) {
            const { output, done } = decoder.feed(c);
            emitted += output;
            if (done) break;
        }
        emitted += decoder.finish(1024 * 1024);
        return emitted;
    }

    test("arbitrary byte slices with escapes & unicode (Go test 1)", () => {
        const chunks = [
            `{"`,
            `content`,
            `": `,
            `"Hello `,
            `world\n`,
            `Line 2 `,
            `\\u4e16\\u754c `,
            `\\ud83d\\ude00"`,
            `}`,
        ];
        const emitted = feedAll(new IncrementalJSONStringDecoder(), chunks);
        assert.strictEqual(emitted, "Hello world\nLine 2 世界 \u{1F600}");
    });

    test("alternative key (text)", () => {
        const chunks = [`{"`, `text`, `": `, `"Alternative key content"`, `}`];
        const emitted = feedAll(new IncrementalJSONStringDecoder(), chunks);
        assert.strictEqual(emitted, "Alternative key content");
    });

    test("raw text fallback (no JSON wrapper)", () => {
        const chunks = [`Hello `, `raw `, `text `, `stream`];
        const emitted = feedAll(new IncrementalJSONStringDecoder(), chunks);
        assert.strictEqual(emitted, "Hello raw text stream");
    });

    test("UTF-8 split across chunk boundaries (no U+FFFD)", () => {
        const chunk1 = `{"content": "` + Buffer.from([0xe4, 0xbd]).toString("latin1");
        const chunk2 = Buffer.from([0xa0, 0xe5]).toString("latin1");
        const chunk3 = Buffer.from([0xa5, 0xbd]).toString("latin1") + `世界"}`;
        const emitted = feedAll(new IncrementalJSONStringDecoder(), [chunk1, chunk2, chunk3]);
        assert.strictEqual(emitted, "你好世界");
        assert.ok(!emitted.includes("\uFFFD"), "replacement char must not appear");
    });

    test("extreme byte-by-byte feed (UTF-8 bytes, Go []byte semantics)", () => {
        const rawJSON = `{"content": "你好，世界！🌟🚀"}`;
        const bytes = Buffer.from(rawJSON, "utf8");
        const dec = new IncrementalJSONStringDecoder();
        let emitted = "";
        for (let i = 0; i < bytes.length; i++) {
            const chunk = Buffer.from([bytes[i]]).toString("latin1");
            const { output } = dec.feed(chunk);
            emitted += output;
        }
        emitted += dec.finish(1024 * 1024);
        assert.strictEqual(emitted, "你好，世界！🌟🚀");
        assert.ok(!emitted.includes("\uFFFD"));
    });

    test("literal quotes inside value survive", () => {
        const emitted = feedAll(new IncrementalJSONStringDecoder(), [`{"content": "He said "`, `hi" to me"}`]);
        assert.strictEqual(emitted, 'He said "hi" to me');
    });
});

describe("streamExtractor (Gemini SSE chunk transformer)", () => {
    function parseChunk(json) {
        return JSON.parse(json);
    }

    test("synthetic-only full args chunk -> text part, finishReason TOOL_CALLS -> STOP", () => {
        const ex = createStreamExtractor(BASE_CFG, "agw_emit_stream123");
        const chunk1 = parseChunk(
            `{"candidates":[{"index":0,"content":{"parts":[{"functionCall":{"name":"agw_emit_stream123","args":{"content":"Streamed message content."}}}]}}]}`
        );
        const finish = parseChunk(`{"candidates":[{"index":0,"finishReason":"TOOL_CALLS"}]}`);

        const r1 = ex.processChunk(chunk1);
        assert.strictEqual(r1.data.candidates[0].content.parts[0].text, "Streamed message content.");
        assert.ok(!JSON.stringify(r1.data).includes("agw_emit_stream123"), "synthetic name must not leak");

        const r2 = ex.processChunk(finish);
        assert.strictEqual(r2.data.candidates[0].finishReason, "STOP");
        assert.strictEqual(ex.stats.syntheticHit, true);
        assert.strictEqual(ex.stats.conflict, false);
    });

    test("plain text streaming unaffected (no synthetic involved)", () => {
        const ex = createStreamExtractor(BASE_CFG, "agw_emit_unused");
        const c1 = parseChunk(`{"candidates":[{"index":0,"content":{"parts":[{"text":"Hello "}]}}]}`);
        const c2 = parseChunk(`{"candidates":[{"index":0,"content":{"parts":[{"text":"world!"}]}}]}`);
        const c3 = parseChunk(`{"candidates":[{"index":0,"finishReason":"STOP"}]}`);

        const r1 = ex.processChunk(c1);
        const r2 = ex.processChunk(c2);
        const r3 = ex.processChunk(c3);

        assert.strictEqual(r1.data.candidates[0].content.parts[0].text, "Hello ");
        assert.strictEqual(r2.data.candidates[0].content.parts[0].text, "world!");
        assert.strictEqual(r3.data.candidates[0].finishReason, "STOP");
        assert.strictEqual(ex.stats.syntheticHit, false);
    });

    test("direct streaming mode (sideBuffer 0): text flushed immediately; conflict flagged on synthetic hit", () => {
        const ex = createStreamExtractor({ ...BASE_CFG, sideBufferBytes: 0 }, "agw_emit_stream_conf");
        const preamble = parseChunk(
            `{"candidates":[{"index":0,"content":{"parts":[{"text":"Standard preamble that was already flushed."}]}}]}`
        );
        const synth = parseChunk(
            `{"candidates":[{"index":0,"content":{"parts":[{"functionCall":{"name":"agw_emit_stream_conf","args":{"content":"Real Answer"}}}]}}]}`
        );

        const r1 = ex.processChunk(preamble);
        assert.strictEqual(r1.data.candidates[0].content.parts[0].text, "Standard preamble that was already flushed.");
        const r2 = ex.processChunk(synth);
        assert.strictEqual(r2.data.candidates[0].content.parts[0].text, "Real Answer");
        assert.strictEqual(ex.stats.conflict, true, "flushed preamble + synthetic answer = conflict");
    });

    test("buffered mode: preamble suppressed once synthetic hits (no leak)", () => {
        const ex = createStreamExtractor({ ...BASE_CFG, sideBufferBytes: 4096 }, "agw_emit_stream_buf");
        const preamble = parseChunk(
            `{"candidates":[{"index":0,"content":{"parts":[{"text":"Standard preamble that must be dropped."}]}}]}`
        );
        const synth = parseChunk(
            `{"candidates":[{"index":0,"content":{"parts":[{"functionCall":{"name":"agw_emit_stream_buf","args":{"content":"Authoritative answer"}}}]}}]}`
        );

        const r1 = ex.processChunk(preamble);
        assert.strictEqual(r1.data, null, "preamble buffered, not yet emitted");
        const r2 = ex.processChunk(synth);
        assert.strictEqual(r2.data.candidates[0].content.parts[0].text, "Authoritative answer");
        assert.strictEqual(ex.stats.conflict, true);
    });

    test("buffer flushes at end of stream when no synthetic ever arrives", () => {
        const ex = createStreamExtractor({ ...BASE_CFG, sideBufferBytes: 4096 }, "agw_emit_none");
        const c1 = parseChunk(`{"candidates":[{"index":0,"content":{"parts":[{"text":"Hello there"}]}}]}`);
        const c2 = parseChunk(`{"candidates":[{"index":0,"finishReason":"STOP"}]}`);

        const r1 = ex.processChunk(c1);
        assert.strictEqual(r1.data, null, "buffered");
        const r2 = ex.processChunk(c2);
        // final flush: buffered text emitted before finishReason chunk
        assert.strictEqual(r2.data.candidates[0].content.parts[0].text, "Hello there");
        const r3 = ex.finish();
        assert.ok(r3 === null || r3 === undefined, "no dangling buffer after finish");
    });

    test("thinking parts passthrough immediately, then synthetic answer", () => {
        const ex = createStreamExtractor({ ...BASE_CFG, sideBufferBytes: 0 }, "agw_emit_stream_reason");
        const t1 = parseChunk(
            `{"candidates":[{"index":0,"content":{"parts":[{"text":"Thinking step 1...","thought":true}]}}]}`
        );
        const t2 = parseChunk(
            `{"candidates":[{"index":0,"content":{"parts":[{"text":"Thinking step 2.","thought":true}]}}]}`
        );
        const synth = parseChunk(
            `{"candidates":[{"index":0,"content":{"parts":[{"functionCall":{"name":"agw_emit_stream_reason","args":{"content":"Final answer"}}}]}}]}`
        );

        const r1 = ex.processChunk(t1);
        assert.deepStrictEqual(r1.data.candidates[0].content.parts[0], { text: "Thinking step 1...", thought: true });
        const r2 = ex.processChunk(t2);
        assert.strictEqual(r2.data.candidates[0].content.parts[0].text, "Thinking step 2.");
        const r3 = ex.processChunk(synth);
        assert.strictEqual(r3.data.candidates[0].content.parts[0].text, "Final answer");
    });

    test("incremental functionCall args merged across chunks (same synthetic name)", () => {
        const ex = createStreamExtractor(BASE_CFG, "agw_emit_stream_inc");
        const c1 = parseChunk(
            `{"candidates":[{"index":0,"content":{"parts":[{"functionCall":{"name":"agw_emit_stream_inc","args":{"content":"Part one "}}}]}}]}`
        );
        const c2 = parseChunk(
            `{"candidates":[{"index":0,"content":{"parts":[{"functionCall":{"args":{"content":"part two"}}}]}}]}`
        );

        const r1 = ex.processChunk(c1);
        assert.strictEqual(r1.data.candidates[0].content.parts[0].text, "Part one ", "first increment emitted");
        const r2 = ex.processChunk(c2);
        assert.strictEqual(r2.data.candidates[0].content.parts[0].text, "part two", "second increment appended");
    });

    test("real tool calls pass through untouched; finishReason TOOL_CALLS preserved", () => {
        const ex = createStreamExtractor({ ...BASE_CFG, sideBufferBytes: 0 }, "agw_emit_stream_real");
        const c1 = parseChunk(
            `{"candidates":[{"index":0,"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"Beijing"}}}]}}]}`
        );
        const c2 = parseChunk(`{"candidates":[{"index":0,"finishReason":"TOOL_CALLS"}]}`);

        const r1 = ex.processChunk(c1);
        assert.deepStrictEqual(r1.data.candidates[0].content.parts, [
            { functionCall: { args: { city: "Beijing" }, name: "get_weather" } },
        ]);
        const r2 = ex.processChunk(c2);
        assert.strictEqual(r2.data.candidates[0].finishReason, "TOOL_CALLS");
        assert.strictEqual(ex.stats.realToolCount, 1);
    });

    test("usage-only chunk passthrough", () => {
        const ex = createStreamExtractor(BASE_CFG, "agw_emit_stream_usage");
        const c1 = parseChunk(`{"candidates":[{"index":0,"content":{"parts":[{"text":"Hi"}]}}]}`);
        const usage = parseChunk(`{"usageMetadata":{"totalTokenCount":15},"candidates":[]}`);

        ex.processChunk(c1);
        const r2 = ex.processChunk(usage);
        assert.strictEqual(r2.data.usageMetadata.totalTokenCount, 15);
    });
});
