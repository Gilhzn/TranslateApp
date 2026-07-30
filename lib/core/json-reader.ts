import type { JsonValue } from "@/lib/types";
import { encodeKey } from "./keys";
import { registerKeyOrder, setMember, type KeyOrderMap } from "./key-order";

/**
 * An order-preserving JSON reader.
 *
 * `JSON.parse` is not usable as the only parse pass here, for two reasons:
 *
 * 1. It destroys authored key order for integer-like keys (see `key-order.ts`),
 *    which breaks the promise that the emitted file is a minimal diff of the
 *    uploaded one.
 * 2. Its syntax errors are engine-specific prose ("Unexpected token }",
 *    "JSON.parse: expected ':'") whose position has to be scraped back out of
 *    the message with a regex.
 *
 * This recursive-descent reader fixes both: it records every object's keys in
 * source order as it goes, and it reports failures with an exact character
 * offset and a message written for the developer who has to fix the file.
 *
 * It accepts exactly RFC 8259 / ECMA-404 — the same language `JSON.parse`
 * accepts, including lone surrogates in `\u` escapes, which are legal JSON and
 * appear in real catalogues that store half of an emoji pair.
 */

export class JsonReadError extends Error {
  /** The bare reason, with no location decoration. */
  readonly reason: string;
  /** 0-based character offset into the text that was read. */
  readonly offset: number;

  constructor(reason: string, offset: number) {
    super(reason);
    this.name = "JsonReadError";
    this.reason = reason;
    this.offset = offset;
  }
}

export interface JsonDocument {
  /** The parsed value. Structurally identical to `JSON.parse`'s result. */
  root: JsonValue;
  /** Encoded node path -> object keys in source order. */
  keyOrder: KeyOrderMap;
}

/**
 * Nesting ceiling.
 *
 * Every consumer of the tree (flatten, rebuild, stats, the emitter) is
 * recursive, and V8 blows its stack somewhere between 8k and 16k frames. A
 * document deeper than this would parse only to crash a later pass, so it is
 * rejected here with an explanation instead. No hand-written locale file comes
 * within two orders of magnitude of the limit.
 */
export const MAX_NESTING_DEPTH = 2000;

const NUMBER_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const BAREWORD_RE = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const HEX4_RE = /^[0-9a-fA-F]{4}$/;
/** Characters that cannot legally follow a number token. */
const NUMBER_TAIL_RE = /[0-9A-Za-z._+-]/;

/** Render a character for an error message: `'x'`, or `U+001F` for controls. */
function describeChar(char: string): string {
  const code = char.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) {
    return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return `'${char}'`;
}

export function readJsonDocument(text: string): JsonDocument {
  let i = 0;
  const keyOrder = new Map<string, readonly string[]>();
  /** Path to the node currently being read; drives the keyOrder keys. */
  const path: Array<string | number> = [];

  const fail = (reason: string, at: number = i): never => {
    throw new JsonReadError(reason, Math.min(at, text.length));
  };

  /** `'x'` for the character at the cursor, or a phrase when at the end. */
  const here = (): string => {
    const char = text[i];
    return char === undefined ? "the end of the file" : describeChar(char);
  };

  const skipWhitespace = (): void => {
    while (i < text.length) {
      const code = text.charCodeAt(i);
      // JSON whitespace is exactly space, tab, LF and CR.
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
        i += 1;
      } else {
        break;
      }
    }
  };

  const readEscape = (start: number): string => {
    const char = text[i];
    if (char === undefined) {
      return fail(
        "Unterminated string — the file ended inside a string literal.",
        start,
      );
    }
    if (char === "u") {
      const hex = text.slice(i + 1, i + 5);
      if (!HEX4_RE.test(hex)) {
        return fail(
          `Invalid \\u escape — expected four hexadecimal digits, found ${JSON.stringify(hex)}.`,
          i - 1,
        );
      }
      i += 5;
      // Deliberately fromCharCode, not fromCodePoint: each \u escape is one
      // UTF-16 code unit, and a surrogate pair is written as two escapes.
      return String.fromCharCode(Number.parseInt(hex, 16));
    }
    i += 1;
    switch (char) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "/":
        return "/";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return fail(
          `Unknown escape sequence "\\${char}" in a string — JSON allows \\" \\\\ \\/ \\b \\f \\n \\r \\t and \\uXXXX.`,
          i - 2,
        );
    }
  };

  /** Reads a string literal; the cursor must be on the opening quote. */
  const readString = (): string => {
    const start = i;
    i += 1;
    let out = "";
    // Copy verbatim runs in slices rather than character by character; escapes
    // are rare, so most strings cost exactly one slice.
    let chunkStart = i;
    for (;;) {
      if (i >= text.length) {
        return fail(
          "Unterminated string — the file ended before the closing quote.",
          start,
        );
      }
      const code = text.charCodeAt(i);
      if (code === 0x22) {
        out += text.slice(chunkStart, i);
        i += 1;
        return out;
      }
      if (code === 0x5c) {
        out += text.slice(chunkStart, i);
        i += 1;
        out += readEscape(start);
        chunkStart = i;
        continue;
      }
      if (code < 0x20) {
        return fail(
          `Unescaped control character U+${code.toString(16).toUpperCase().padStart(4, "0")} in a string — write it as an escape such as \\n or \\u${code.toString(16).toUpperCase().padStart(4, "0")}.`,
          i,
        );
      }
      i += 1;
    }
  };

  const readNumber = (): number => {
    const start = i;
    NUMBER_RE.lastIndex = i;
    const match = NUMBER_RE.exec(text);
    if (match === null || match.index !== start) {
      return fail(
        `Invalid number — JSON numbers look like -1, 0, 12.5 or 6e3 (no leading '+', no leading zeros, no hex).`,
        start,
      );
    }
    const literal = match[0];
    i = start + literal.length;
    const tail = text[i];
    // "01", "1.2.3" and "1px" all match a valid prefix; catch the leftovers
    // here so the message names the real problem.
    if (tail !== undefined && NUMBER_TAIL_RE.test(tail)) {
      return fail(
        `Invalid number ${JSON.stringify(text.slice(start, i + 1))} — JSON numbers look like -1, 0, 12.5 or 6e3 (no leading '+', no leading zeros, no hex).`,
        start,
      );
    }
    return Number(literal);
  };

  const readLiteral = (word: string, value: JsonValue): JsonValue => {
    if (text.startsWith(word, i)) {
      i += word.length;
      return value;
    }
    return unexpectedValue();
  };

  const unexpectedValue = (): never => {
    if (i >= text.length) {
      return fail(
        "Expected a value but the file ended — the document is incomplete.",
      );
    }
    const char = text[i];
    if (char === "'") {
      return fail(
        "JSON strings must be wrapped in double quotes, not single quotes.",
      );
    }
    BAREWORD_RE.lastIndex = i;
    const bareword = BAREWORD_RE.exec(text);
    if (bareword !== null && bareword.index === i) {
      return fail(
        `Expected a value but found the bareword '${bareword[0]}' — JSON allows only true, false and null unquoted.`,
      );
    }
    return fail(
      `Expected a value (object, array, string, number, true, false or null) but found ${here()}.`,
    );
  };

  const readObject = (depth: number): { [k: string]: JsonValue } => {
    const out: { [k: string]: JsonValue } = {};
    const order: string[] = [];
    const seen = new Set<string>();
    i += 1; // consume '{'

    skipWhitespace();
    if (text[i] === "}") {
      i += 1;
      return out;
    }

    for (;;) {
      skipWhitespace();
      if (text[i] !== '"') {
        if (text[i] === "}") {
          return fail(
            "Expected a property name in double quotes but found '}' — remove the trailing comma.",
          );
        }
        return fail(
          `Expected a property name in double quotes but found ${here()}.`,
        );
      }
      const key = readString();

      skipWhitespace();
      if (text[i] !== ":") {
        return fail(
          `Expected ':' after the property name ${JSON.stringify(key)} but found ${here()}.`,
        );
      }
      i += 1;

      skipWhitespace();
      path.push(key);
      const value = readValue(depth + 1);
      path.pop();

      // Duplicate keys follow JSON.parse: the last value wins, and the key
      // keeps the position of its first appearance (that is also where the
      // ECMAScript property would have been inserted).
      setMember(out, key, value);
      if (!seen.has(key)) {
        seen.add(key);
        order.push(key);
      }

      skipWhitespace();
      const next = text[i];
      if (next === ",") {
        i += 1;
        continue;
      }
      if (next === "}") {
        i += 1;
        break;
      }
      return fail(
        `Expected ',' or '}' after a property value but found ${here()}.`,
      );
    }

    // Recorded on both channels: by path for the serialisable catalog map, by
    // identity so a bare tree still emits in the right order.
    keyOrder.set(encodeKey(path), order);
    registerKeyOrder(out, order);
    return out;
  };

  const readArray = (depth: number): JsonValue[] => {
    const out: JsonValue[] = [];
    i += 1; // consume '['

    skipWhitespace();
    if (text[i] === "]") {
      i += 1;
      return out;
    }

    for (;;) {
      skipWhitespace();
      if (text[i] === "]") {
        return fail(
          "Expected a value but found ']' — remove the trailing comma.",
        );
      }
      path.push(out.length);
      out.push(readValue(depth + 1));
      path.pop();

      skipWhitespace();
      const next = text[i];
      if (next === ",") {
        i += 1;
        continue;
      }
      if (next === "]") {
        i += 1;
        break;
      }
      return fail(
        `Expected ',' or ']' after an array element but found ${here()}.`,
      );
    }
    return out;
  };

  const readValue = (depth: number): JsonValue => {
    if (depth > MAX_NESTING_DEPTH) {
      return fail(
        `Nesting is deeper than ${MAX_NESTING_DEPTH} levels — this is almost certainly not a translation catalogue.`,
      );
    }
    const char = text[i];
    switch (char) {
      case "{":
        return readObject(depth);
      case "[":
        return readArray(depth);
      case '"':
        return readString();
      case "t":
        return readLiteral("true", true);
      case "f":
        return readLiteral("false", false);
      case "n":
        return readLiteral("null", null);
      default:
        break;
    }
    if (char !== undefined && (char === "-" || (char >= "0" && char <= "9"))) {
      return readNumber();
    }
    return unexpectedValue();
  };

  skipWhitespace();
  if (i >= text.length) {
    fail("The file contains no JSON value.");
  }
  const root = readValue(0);
  skipWhitespace();
  if (i < text.length) {
    fail(
      `Unexpected ${here()} after the end of the top-level value — a JSON file contains exactly one value.`,
    );
  }

  return { root, keyOrder };
}
