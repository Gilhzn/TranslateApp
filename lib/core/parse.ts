import type { JsonValue, LocaleCode, SourceCatalog } from "@/lib/types";
import { collectTreeStats, flattenJson } from "./flatten";

/**
 * Source file parsing.
 *
 * Two things matter here beyond calling `JSON.parse`:
 *
 * 1. **Error quality.** Developers debug their own `en.json` through this
 *    message, so a failure reports line, column, the offending line and a caret
 *    — not "Unexpected token }".
 * 2. **Formatting fidelity.** Quality bar #2 says the output file must be
 *    structurally identical to the input, which includes its indentation and
 *    its trailing newline. Both are recovered from the raw text before parsing,
 *    since `JSON.parse` throws that information away.
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
 * V8, JavaScriptCore and SpiderMonkey all describe JSON syntax errors
 * differently. Every one of them exposes either a character offset or an
 * explicit line/column, so both shapes are probed.
 */
function locateSyntaxError(raw: string, message: string): Location | null {
  const byPosition = /position (\d+)/i.exec(message);
  if (byPosition) {
    const digits = byPosition[1];
    if (digits !== undefined) {
      return locationOf(raw, Number.parseInt(digits, 10));
    }
  }
  const byLineColumn = /line (\d+) column (\d+)/i.exec(message);
  if (byLineColumn) {
    const line = byLineColumn[1];
    const column = byLineColumn[2];
    if (line !== undefined && column !== undefined) {
      return {
        line: Number.parseInt(line, 10),
        column: Number.parseInt(column, 10),
      };
    }
  }
  return null;
}

/** Strip the engine's own location suffix; we render a better one. */
function cleanEngineMessage(message: string): string {
  return message
    .replace(/^JSON\.parse:\s*/i, "")
    .replace(/\s*in JSON at position \d+(?:\s*\(line \d+ column \d+\))?/i, "")
    .replace(/\s*at line \d+ column \d+ of the JSON data/i, "")
    .replace(/\s+$/, "")
    .trim();
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
 * Parse an uploaded locale file into a {@link SourceCatalog}.
 *
 * @throws {JsonParseError} on invalid JSON or a non-object root.
 */
export function parseSourceFile(
  fileName: string,
  rawText: string,
  options: ParseOptions = {},
): SourceCatalog {
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = cleanEngineMessage(raw);
    const loc = locateSyntaxError(text, raw);
    throw new JsonParseError({
      fileName,
      reason: message.length > 0 ? message : "Invalid JSON.",
      line: loc?.line ?? null,
      column: loc?.column ?? null,
      position: null,
      snippet: loc ? renderSnippet(text, loc) : "",
    });
  }

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

  // `parsed` came from JSON.parse, so it is structurally a JsonValue object.
  const tree = parsed as { [k: string]: JsonValue };
  const entries = flattenJson(tree);
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
    indent: detectIndent(text),
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

/**
 * Serialise a rebuilt tree using the catalog's own formatting, so a diff
 * against the source file shows only the translated values.
 */
export function serializeWithCatalogFormatting(
  catalog: Pick<SourceCatalog, "indent" | "trailingNewline">,
  tree: JsonValue,
): string {
  const body = JSON.stringify(tree, null, catalog.indent);
  return catalog.trailingNewline ? `${body}\n` : body;
}
