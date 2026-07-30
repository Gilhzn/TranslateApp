import type { JsonValue, LocaleCode, SourceCatalog } from "@/lib/types";
import { collectTreeStats, flattenJson } from "./flatten";
import { JsonReadError, readJsonDocument } from "./json-reader";
import {
  orderKeys,
  resolveKeyOrder,
  type KeyOrderMap,
} from "./key-order";

/**
 * Source file parsing.
 *
 * Three things matter here beyond turning text into a tree:
 *
 * 1. **Error quality.** Developers debug their own `en.json` through this
 *    message, so a failure reports line, column, the offending line and a caret
 *    — not "Unexpected token }". The offsets come from our own reader, so they
 *    are exact rather than scraped out of an engine string.
 * 2. **Formatting fidelity.** Quality bar #2 says the output file must be
 *    structurally identical to the input, which includes its indentation and
 *    its trailing newline. Both are recovered from the raw text before parsing,
 *    since a parsed tree does not carry them.
 * 3. **Key order.** JavaScript objects re-sort integer-like keys, so the order
 *    is captured separately by the reader (see `key-order.ts`) and honoured by
 *    a hand-written emitter — `JSON.stringify` re-reads JS property order and
 *    would undo it.
 */

export class JsonParseError extends Error {
  readonly fileName: string;
  /** The bare reason, without file/location decoration. */
  readonly reason: string;
  /** 1-based; null when the engine reported no position. */
  readonly line: number | null;
  /** 1-based; null when the engine reported no position. */
  readonly column: number | null;
  /** 0-based character offset; null when unknown. */
  readonly position: number | null;
  /** Rendered source excerpt with a caret under the offending character. */
  readonly snippet: string;

  constructor(init: {
    fileName: string;
    reason: string;
    line: number | null;
    column: number | null;
    position: number | null;
    snippet: string;
  }) {
    const where =
      init.line !== null && init.column !== null
        ? ` (line ${init.line}, column ${init.column})`
        : "";
    super(
      init.snippet.length > 0
        ? `${init.fileName}${where}: ${init.reason}\n\n${init.snippet}`
        : `${init.fileName}${where}: ${init.reason}`,
    );
    this.name = "JsonParseError";
    this.fileName = init.fileName;
    this.reason = init.reason;
    this.line = init.line;
    this.column = init.column;
    this.position = init.position;
    this.snippet = init.snippet;
  }
}

interface Location {
  line: number;
  column: number;
}

function locationOf(raw: string, position: number): Location {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < position && i < raw.length; i++) {
    if (raw[i] === "\n") {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: position - lineStart + 1 };
}

/**
 * Render the failing line with a caret, plus one line of leading context:
 *
 *     3 |   "b": 2,
 *   > 4 |   "c" 3
 *       |       ^
 */
function renderSnippet(raw: string, loc: Location): string {
  const lines = raw.split(/\r?\n/);
  const index = loc.line - 1;
  const target = lines[index];
  if (target === undefined) return "";

  const gutterWidth = String(loc.line).length;
  const pad = (n: number): string => String(n).padStart(gutterWidth, " ");
  const out: string[] = [];

  const previous = index > 0 ? lines[index - 1] : undefined;
  if (previous !== undefined) out.push(`  ${pad(loc.line - 1)} | ${previous}`);
  out.push(`> ${pad(loc.line)} | ${target}`);
  // Tabs in the source would misalign a space-built caret line.
  const prefix = target.slice(0, Math.max(0, loc.column - 1));
  const caretPad = prefix.replace(/[^\t]/g, " ");
  out.push(`  ${" ".repeat(gutterWidth)} | ${caretPad}^`);

  const next = lines[index + 1];
  if (next !== undefined) out.push(`  ${pad(loc.line + 1)} | ${next}`);
  return out.join("\n");
}

/**
 * Detect the file's indentation unit.
 *
 * The first line that begins with whitespace is, in any conventionally
 * formatted JSON document, exactly one level deep — so its leading whitespace
 * *is* the indent unit. Minified documents have no such line and re-emit
 * minified.
 */
export function detectIndent(raw: string): string {
  for (const line of raw.split("\n")) {
    const match = /^([ \t]+)[^\s]/.exec(line);
    if (match) {
      const indent = match[1];
      if (indent !== undefined) return indent;
    }
  }
  return "";
}

/**
 * Detect the file's line-ending style.
 *
 * A CRLF working copy (the default on Windows with `core.autocrlf`) must come
 * back CRLF, or every single line of the file shows up as changed in the
 * developer's diff. Mixed files are re-emitted in whichever style dominates,
 * which is the same rule editors use; a file with no newline at all is "\n".
 */
export function detectEol(raw: string): "\n" | "\r\n" {
  let crlf = 0;
  let loneLf = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "\n") continue;
    if (i > 0 && raw[i - 1] === "\r") crlf += 1;
    else loneLf += 1;
  }
  return crlf > loneLf ? "\r\n" : "\n";
}

const LOCALE_RE = /^([a-z]{2,3})(?:[-_]([A-Za-z]{2,4}))?$/;

/** Normalise `pt_br` / `PT-br` to the conventional `pt-BR`. */
function normaliseLocale(language: string, region: string | undefined): string {
  if (region === undefined) return language.toLowerCase();
  const lower = region.toLowerCase();
  const normalisedRegion =
    region.length === 4
      ? `${lower.charAt(0).toUpperCase()}${lower.slice(1)}` // script subtag, e.g. Hans
      : lower.toUpperCase();
  return `${language.toLowerCase()}-${normalisedRegion}`;
}

/**
 * Infer the source locale from conventional file names: `en.json`,
 * `pt-BR.json`, `locales/de/common.json`, `messages.fr.json`.
 */
export function inferLocaleFromFileName(fileName: string): LocaleCode | null {
  const segments = fileName.split(/[\\/]/).filter((s) => s.length > 0);
  const base = segments[segments.length - 1];
  if (base === undefined) return null;

  const withoutExtension = base.replace(/\.[A-Za-z0-9]+$/, "");
  const candidates = [withoutExtension, ...withoutExtension.split(".")];
  // A directory-named locale (`locales/de/common.json`) is the last fallback.
  const parent = segments[segments.length - 2];
  if (parent !== undefined) candidates.push(parent);

  for (const candidate of candidates) {
    const match = LOCALE_RE.exec(candidate);
    if (match) {
      const language = match[1];
      if (language !== undefined) return normaliseLocale(language, match[2]);
    }
  }
  return null;
}

export interface ParseOptions {
  /** Overrides the locale inferred from the file name. */
  sourceLocale?: LocaleCode;
}

/**
 * A {@link SourceCatalog} plus the source key order the shared contract has no
 * field for.
 *
 * `SourceCatalog` in `lib/types.ts` is frozen, and key order cannot live inside
 * `tree` (a JS object cannot hold it). It is therefore added here as an extra,
 * optional-to-ignore property: a `ParsedCatalog` is a `SourceCatalog`
 * everywhere, and consumers that never look at `keyOrder` still get correct
 * output because every node's order is also registered by identity.
 *
 * The identity registry does not survive a `JSON.stringify` hop, and neither
 * does a `Map`. To move a catalog across the wire, send
 * `toSerializableKeyOrder(catalog.keyOrder)` alongside it and rebuild the map
 * with `keyOrderFromEntries` on the far side, then pass it explicitly to
 * `rebuildTree` / `serializeWithCatalogFormatting`.
 */
export interface ParsedCatalog extends SourceCatalog {
  /** Encoded node path -> that object's keys in source order. */
  keyOrder: KeyOrderMap;
  /**
   * Source line-ending style. Like `keyOrder`, a contract extension rather than
   * a `SourceCatalog` field, because `SourceCatalog` is frozen.
   */
  readonly eol: "\n" | "\r\n";
}

/**
 * Parse an uploaded locale file into a {@link ParsedCatalog}.
 *
 * @throws {JsonParseError} on invalid JSON or a non-object root.
 */
export function parseSourceFile(
  fileName: string,
  rawText: string,
  options: ParseOptions = {},
): ParsedCatalog {
  if (rawText.trim().length === 0) {
    throw new JsonParseError({
      fileName,
      reason: "The file is empty — expected a JSON object of translatable keys.",
      line: null,
      column: null,
      position: null,
      snippet: "",
    });
  }

  // A UTF-8 BOM is legal in files but not in JSON text.
  const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;

  let document: { root: JsonValue; keyOrder: KeyOrderMap };
  try {
    document = readJsonDocument(text);
  } catch (error) {
    if (!(error instanceof JsonReadError)) throw error;
    const loc = locationOf(text, error.offset);
    throw new JsonParseError({
      fileName,
      reason: error.reason,
      line: loc.line,
      column: loc.column,
      position: error.offset,
      snippet: renderSnippet(text, loc),
    });
  }

  const parsed = document.root;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const actual =
      parsed === null
        ? "null"
        : Array.isArray(parsed)
          ? "an array"
          : `a ${typeof parsed}`;
    throw new JsonParseError({
      fileName,
      reason: `Expected the file to contain a JSON object of translation keys, but it contains ${actual}. Wrap the content in an object, e.g. { "greeting": "Hello" }.`,
      line: 1,
      column: 1,
      position: 0,
      snippet: "",
    });
  }

  // The reader only ever produces JsonValue shapes, and the guard above
  // narrowed this one to an object.
  const tree = parsed as { [k: string]: JsonValue };
  const entries = flattenJson(tree, document.keyOrder);
  const { totalLeaves, maxDepth } = collectTreeStats(tree);

  let translatableKeys = 0;
  let totalCharacters = 0;
  for (const entry of entries) {
    if (entry.doNotTranslate) continue;
    translatableKeys += 1;
    // Only translatable characters drive cost and time estimates.
    totalCharacters += entry.value.length;
  }

  return {
    fileName,
    sourceLocale:
      options.sourceLocale ?? inferLocaleFromFileName(fileName) ?? "en",
    entries,
    tree,
    keyOrder: document.keyOrder,
    indent: detectIndent(text),
    eol: detectEol(text),
    trailingNewline: rawText.endsWith("\n"),
    stats: {
      totalKeys: totalLeaves,
      translatableKeys,
      // Everything the flattener refused to translate: metadata keys,
      // non-string leaves and do-not-translate values.
      skippedKeys: totalLeaves - translatableKeys,
      totalCharacters,
      maxDepth,
    },
  };
}

/** The formatting facts needed to re-emit a tree the way it arrived. */
export type CatalogFormatting = Pick<
  SourceCatalog,
  "indent" | "trailingNewline"
> & {
  /** Source key order; a {@link ParsedCatalog} supplies this automatically. */
  readonly keyOrder?: KeyOrderMap;
  /**
   * Source line-ending style; a {@link ParsedCatalog} supplies this
   * automatically. Defaults to "\n" when a caller builds the formatting by
   * hand.
   */
  readonly eol?: "\n" | "\r\n";
};

/**
 * Serialise a tree in the catalog's own formatting and in source key order.
 *
 * This deliberately does not use `JSON.stringify`: that walks objects in
 * ECMAScript property order, which hoists integer-like keys ("7" before "12"
 * before "101") and would silently rewrite the developer's file. Everything
 * else about the output is byte-compatible with
 * `JSON.stringify(tree, null, indent)` — same escaping (leaves are handed to
 * `JSON.stringify` individually), same `": "` separator, same `{}`/`[]` for
 * empty containers, same fully compact form when `indent` is "".
 */
export function serializeWithCatalogFormatting(
  catalog: CatalogFormatting,
  tree: JsonValue,
): string {
  const indent = catalog.indent;
  const eol = catalog.eol ?? "\n";
  const pretty = indent.length > 0;
  const out: string[] = [];
  const path: Array<string | number> = [];
  // Indentation prefixes are reused constantly; build each depth once.
  const prefixes: string[] = [eol];
  const prefixFor = (depth: number): string => {
    for (let d = prefixes.length; d <= depth; d++) {
      prefixes.push(`${eol}${indent.repeat(d)}`);
    }
    // Depths are filled in above, so this index is populated.
    return prefixes[depth] ?? eol;
  };

  const write = (node: JsonValue, depth: number): void => {
    if (node === null || typeof node !== "object") {
      // Primitives: identical escaping and number formatting to JSON.stringify.
      out.push(JSON.stringify(node));
      return;
    }

    if (Array.isArray(node)) {
      if (node.length === 0) {
        out.push("[]");
        return;
      }
      out.push("[");
      for (let index = 0; index < node.length; index++) {
        if (index > 0) out.push(",");
        if (pretty) out.push(prefixFor(depth + 1));
        const child = node[index];
        path.push(index);
        // A hole can only come from a sparse array, which no JSON source
        // produces; JSON.stringify would also emit null for it.
        write(child === undefined ? null : child, depth + 1);
        path.pop();
      }
      if (pretty) out.push(prefixFor(depth));
      out.push("]");
      return;
    }

    const object = node as { [k: string]: JsonValue };
    const keys = orderKeys(
      object,
      resolveKeyOrder(object, path, catalog.keyOrder),
      // An explicitly-undefined member is not representable in JsonValue, but
      // a cast could smuggle one in; JSON.stringify omits those, so do we.
    ).filter((key) => object[key] !== undefined);
    if (keys.length === 0) {
      out.push("{}");
      return;
    }
    out.push("{");
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      if (key === undefined) continue;
      const child = object[key];
      if (child === undefined) continue;
      if (index > 0) out.push(",");
      if (pretty) out.push(prefixFor(depth + 1));
      out.push(JSON.stringify(key));
      out.push(pretty ? ": " : ":");
      path.push(key);
      write(child, depth + 1);
      path.pop();
    }
    if (pretty) out.push(prefixFor(depth));
    out.push("}");
  };

  write(tree, 0);
  if (catalog.trailingNewline) out.push(eol);
  return out.join("");
}
