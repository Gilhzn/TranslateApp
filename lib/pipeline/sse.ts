/**
 * Server-Sent Events framing and parsing, implemented against the WHATWG
 * `text/event-stream` grammar.
 *
 * Written by hand rather than pulled in, and the encoder is deliberately strict
 * about the two ways SSE breaks in practice:
 *
 *   1. A payload containing a newline. `data: {"a":"x\ny"}` is two frames, not
 *      one, and the second is garbage. Every payload is therefore split on line
 *      terminators and emitted as consecutive `data:` lines, which the receiver
 *      rejoins with "\n" — exactly what the spec says to do.
 *   2. A field value containing a newline. `event:` and `id:` are single-line
 *      fields with no continuation form, so embedded terminators are stripped
 *      rather than "escaped" into a frame boundary an attacker controls.
 *
 * `EventSource` cannot POST, so the browser side of this stream has to be read
 * with `fetch` + a manual parser; {@link SseParser} and {@link readSseStream}
 * are that parser, exported so the client does not invent a second one.
 */

/** Line terminators SSE recognises: CRLF, CR, LF. */
const LINE_TERMINATORS = /\r\n|\r|\n/;

export interface SseFrame {
  /** Event name. Omitted means the default, `"message"`. */
  event?: string;
  /** Serialised with `JSON.stringify`. Omit for a comment-only frame. */
  data?: unknown;
  id?: string;
  /** Reconnection hint, in milliseconds. */
  retry?: number;
  /** Comment line(s); ignored by clients but keeps proxies from idling out. */
  comment?: string;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

function dataLines(payload: string): string[] {
  return payload.split(LINE_TERMINATORS).map((line) => `data: ${line}`);
}

/** Encode one frame, terminator included. Returns "" for an empty frame. */
export function encodeSseFrame(frame: SseFrame): string {
  const lines: string[] = [];

  if (frame.comment !== undefined) {
    for (const line of frame.comment.split(LINE_TERMINATORS)) {
      lines.push(`: ${line}`);
    }
  }
  if (frame.id !== undefined) lines.push(`id: ${singleLine(frame.id)}`);
  if (frame.event !== undefined) lines.push(`event: ${singleLine(frame.event)}`);
  if (frame.retry !== undefined && Number.isFinite(frame.retry)) {
    lines.push(`retry: ${Math.max(0, Math.trunc(frame.retry))}`);
  }
  if ("data" in frame) {
    // `JSON.stringify(undefined)` is `undefined`, which would produce the
    // literal frame `data: undefined` and fail to parse on the far side.
    const payload = JSON.stringify(frame.data ?? null) ?? "null";
    lines.push(...dataLines(payload));
  }

  if (lines.length === 0) return "";
  return `${lines.join("\n")}\n\n`;
}

/** Convenience for the common named-event-with-JSON-payload case. */
export function encodeSseEvent(event: string, data: unknown): string {
  return encodeSseFrame({ event, data });
}

export function encodeSseComment(text: string): string {
  return encodeSseFrame({ comment: text });
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface SseMessage {
  /** Always populated; defaults to `"message"` when the frame named no event. */
  event: string;
  /** Concatenated `data:` lines, joined with "\n". */
  data: string;
  id: string | undefined;
  retry: number | undefined;
}

/**
 * Incremental `text/event-stream` parser.
 *
 * Chunk boundaries fall wherever the network puts them — mid-field, mid-frame,
 * between the two newlines that end a frame — so the buffer is only ever
 * consumed up to the last complete frame.
 */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const messages: SseMessage[] = [];

    for (;;) {
      const boundary = findFrameEnd(this.buffer);
      if (boundary === null) break;
      const raw = this.buffer.slice(0, boundary.start);
      this.buffer = this.buffer.slice(boundary.end);
      const message = parseFrame(raw);
      if (message !== null) messages.push(message);
    }

    return messages;
  }

  /** Parse whatever is left when the stream ends without a final blank line. */
  flush(): SseMessage[] {
    const rest = this.buffer;
    this.buffer = "";
    if (rest.trim().length === 0) return [];
    const message = parseFrame(rest);
    return message === null ? [] : [message];
  }
}

interface FrameBoundary {
  start: number;
  end: number;
}

/** Index of the blank line that terminates the first complete frame. */
function findFrameEnd(buffer: string): FrameBoundary | null {
  let best: FrameBoundary | null = null;
  for (const terminator of ["\r\n\r\n", "\n\n", "\r\r"]) {
    const at = buffer.indexOf(terminator);
    if (at < 0) continue;
    if (best === null || at < best.start) {
      best = { start: at, end: at + terminator.length };
    }
  }
  return best;
}

function parseFrame(raw: string): SseMessage | null {
  let event = "";
  const data: string[] = [];
  let id: string | undefined;
  let retry: number | undefined;
  let sawField = false;

  for (const line of raw.split(LINE_TERMINATORS)) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    // "If value starts with a U+0020 SPACE, remove it" — exactly one.
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "event":
        event = value;
        sawField = true;
        break;
      case "data":
        data.push(value);
        sawField = true;
        break;
      case "id":
        // The spec ignores an id containing NUL; nothing else is filtered.
        if (!value.includes("\0")) id = value;
        sawField = true;
        break;
      case "retry": {
        const parsed = Number(value);
        if (Number.isInteger(parsed) && parsed >= 0) retry = parsed;
        sawField = true;
        break;
      }
      default:
        break;
    }
  }

  if (!sawField) return null;
  return {
    event: event.length > 0 ? event : "message",
    data: data.join("\n"),
    id,
    retry,
  };
}

/**
 * Read a `text/event-stream` response body as messages.
 *
 * Intended for the browser: `for await (const message of readSseStream(res.body))`.
 */
export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parser = new SseParser();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      for (const message of parser.push(decoder.decode(value, { stream: true }))) {
        yield message;
      }
    }
    const tail = decoder.decode();
    if (tail.length > 0) {
      for (const message of parser.push(tail)) yield message;
    }
    for (const message of parser.flush()) yield message;
  } finally {
    reader.releaseLock();
  }
}
