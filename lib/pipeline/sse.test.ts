import { describe, expect, it } from "vitest";
import {
  SseParser,
  encodeSseComment,
  encodeSseEvent,
  encodeSseFrame,
  readSseStream,
} from "./sse";

describe("encodeSseFrame", () => {
  it("frames a named JSON event with a blank-line terminator", () => {
    expect(encodeSseEvent("progress", { phase: "translating" })).toBe(
      'event: progress\ndata: {"phase":"translating"}\n\n',
    );
  });

  it("splits an embedded newline across consecutive data lines", () => {
    // A raw newline inside a frame would end it early and turn the remainder
    // into a second, malformed frame.
    const frame = encodeSseFrame({ event: "error", data: "line one\nline two" });
    expect(frame).toBe('event: error\ndata: "line one\\nline two"\n\n');

    const multi = encodeSseFrame({ data: { a: 1 } });
    expect(multi).toBe('data: {"a":1}\n\n');
  });

  it("splits payloads that genuinely contain a newline after serialisation", () => {
    // JSON.stringify escapes newlines inside strings, so force the multi-line
    // path with a pre-serialised payload shape the encoder cannot escape away.
    const frame = encodeSseFrame({ comment: "one\ntwo" });
    expect(frame).toBe(": one\n: two\n\n");
  });

  it("strips line terminators from single-line fields", () => {
    const frame = encodeSseFrame({
      event: "evil\n\ndata: injected",
      id: "1\n2",
      data: 1,
    });
    expect(frame).toBe("id: 1 2\nevent: evil data: injected\ndata: 1\n\n");
    // One frame, not two.
    expect(frame.split("\n\n").filter((part) => part.length > 0)).toHaveLength(1);
  });

  it("serialises undefined data as null rather than the literal 'undefined'", () => {
    expect(encodeSseFrame({ event: "done", data: undefined })).toBe(
      "event: done\ndata: null\n\n",
    );
  });

  it("emits comments and retry hints", () => {
    expect(encodeSseComment("keep-alive")).toBe(": keep-alive\n\n");
    expect(encodeSseFrame({ retry: 2500.7 })).toBe("retry: 2500\n\n");
  });

  it("returns an empty string for an empty frame", () => {
    expect(encodeSseFrame({})).toBe("");
  });
});

describe("SseParser", () => {
  it("round-trips what the encoder produced", () => {
    const parser = new SseParser();
    const wire =
      encodeSseEvent("start", { jobId: "job_1" }) +
      encodeSseEvent("progress", { completedUnits: 3 }) +
      encodeSseEvent("done", { ok: true });

    const messages = parser.push(wire);
    expect(messages.map((m) => m.event)).toEqual(["start", "progress", "done"]);
    expect(JSON.parse(messages[1]?.data ?? "null")).toEqual({ completedUnits: 3 });
  });

  it("reassembles frames split across arbitrary chunk boundaries", () => {
    const wire =
      encodeSseEvent("a", { n: 1 }) +
      encodeSseComment("keep-alive") +
      encodeSseEvent("b", { n: 2 });

    const parser = new SseParser();
    const events: string[] = [];
    for (const char of wire) {
      for (const message of parser.push(char)) events.push(message.event);
    }
    expect(events).toEqual(["a", "b"]);
  });

  it("joins multiple data lines with a newline and defaults the event name", () => {
    const parser = new SseParser();
    const [message] = parser.push("data: one\ndata: two\n\n");
    expect(message?.event).toBe("message");
    expect(message?.data).toBe("one\ntwo");
  });

  it("accepts CRLF and CR frame terminators", () => {
    const parser = new SseParser();
    expect(parser.push("event: a\r\ndata: 1\r\n\r\n")).toHaveLength(1);
    expect(parser.push("event: b\rdata: 2\r\r")).toHaveLength(1);
  });

  it("ignores comment-only frames but keeps ids and retry", () => {
    const parser = new SseParser();
    expect(parser.push(": ping\n\n")).toEqual([]);
    const [message] = parser.push("id: 9\nretry: 100\ndata: x\n\n");
    expect(message?.id).toBe("9");
    expect(message?.retry).toBe(100);
  });

  it("flushes a trailing frame that never got its blank line", () => {
    const parser = new SseParser();
    expect(parser.push("event: tail\ndata: 1\n")).toEqual([]);
    const flushed = parser.flush();
    expect(flushed[0]?.event).toBe("tail");
  });
});

describe("readSseStream", () => {
  it("yields every message from a byte stream", async () => {
    const encoder = new TextEncoder();
    const wire =
      encodeSseEvent("progress", { completedUnits: 1 }) +
      encodeSseEvent("done", { ok: true });
    const bytes = encoder.encode(wire);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Deliberately split mid-frame, and inside a multi-byte character run.
        controller.enqueue(bytes.slice(0, 17));
        controller.enqueue(bytes.slice(17));
        controller.close();
      },
    });

    const seen: string[] = [];
    for await (const message of readSseStream(stream)) seen.push(message.event);
    expect(seen).toEqual(["progress", "done"]);
  });
});
