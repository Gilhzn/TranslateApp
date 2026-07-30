/**
 * Tolerant parsing of model output.
 *
 * A model told to emit bare JSON emits bare JSON almost always. "Almost" is
 * the whole problem: at batch scale the rare failure is a certainty, and the
 * cost of a thrown exception here is an entire batch of good translations
 * discarded because one character was wrong.
 *
 * So this parser never throws. It peels away the four things that actually go
 * wrong in practice — markdown fences, chatty preamble, trailing commas, and
 * the model returning the array instead of the wrapper — and reports whatever
 * it could not recover as an `Issue` for the pipeline to act on.
 *
 * It is deliberately NOT lenient about identity: an entry whose key was not
 * requested is dropped rather than guessed at, and a requested key that never
 * came back is reported per-key so the orchestrator can retry exactly that one.
 */

import type { Issue, ProviderTranslation } from "@/lib/types";

export interface ParsedProviderOutput {
  translations: ProviderTranslation[];
  issues: Issue[];
}

/** Keys the batch asked for. Order is preserved in the missing-key report. */
export interface ParseOptions {
  /** When given, entries outside this set are dropped and absentees reported. */
  expectedKeys?: readonly string[];
  /** Label used in issue messages, e.g. the provider id. */
  source?: string;
}

const MAX_REPORTED_KEYS = 12;

export function parseProviderOutput(
  raw: string,
  options: ParseOptions = {},
): ParsedProviderOutput {
  const issues: Issue[] = [];
  const label = options.source ?? "provider";

  const text = stripWrapper(raw);
  if (text.trim().length === 0) {
    issues.push(
      providerError(`The ${label} returned an empty response.`, {
        rawLength: raw.length,
      }),
    );
    return finish([], issues, options);
  }

  const value = extractJson(text);
  if (value === undefined) {
    issues.push(
      providerError(
        `The ${label} response could not be parsed as JSON.`,
        { preview: preview(text) },
      ),
    );
    return finish([], issues, options);
  }

  const entries = collectEntries(value);
  if (entries === null) {
    issues.push(
      providerError(
        `The ${label} returned JSON in an unrecognised shape (expected {"translations":[…]}).`,
        { preview: preview(text) },
      ),
    );
    return finish([], issues, options);
  }

  const translations: ProviderTranslation[] = [];
  const seen = new Set<string>();
  let malformed = 0;
  let duplicates = 0;

  for (const entry of entries) {
    const parsed = readEntry(entry);
    if (parsed === null) {
      malformed += 1;
      continue;
    }
    if (seen.has(parsed.key)) {
      duplicates += 1;
      continue; // first answer wins; a model that repeats itself is guessing
    }
    seen.add(parsed.key);
    translations.push(parsed);
  }

  if (malformed > 0) {
    issues.push(
      providerError(
        `Dropped ${malformed} malformed entr${malformed === 1 ? "y" : "ies"} from the ${label} response (missing or non-string "key"/"target").`,
        { droppedEntries: malformed },
        "warning",
      ),
    );
  }
  if (duplicates > 0) {
    issues.push({
      code: "provider-error",
      severity: "info",
      message: `The ${label} returned ${duplicates} duplicate key${duplicates === 1 ? "" : "s"}; the first answer for each was kept.`,
      detail: { duplicateEntries: duplicates },
    });
  }

  return finish(translations, issues, options);
}

// ---------------------------------------------------------------------------
// Key reconciliation
// ---------------------------------------------------------------------------

function finish(
  translations: ProviderTranslation[],
  issues: Issue[],
  options: ParseOptions,
): ParsedProviderOutput {
  const expected = options.expectedKeys;
  if (expected === undefined) return { translations, issues };

  const wanted = new Set(expected);
  const kept: ProviderTranslation[] = [];
  const unexpected: string[] = [];

  for (const translation of translations) {
    if (wanted.has(translation.key)) kept.push(translation);
    else unexpected.push(translation.key);
  }

  if (unexpected.length > 0) {
    issues.push({
      code: "provider-error",
      severity: "warning",
      message: `Dropped ${unexpected.length} translation${unexpected.length === 1 ? "" : "s"} for key${unexpected.length === 1 ? "" : "s"} that were not requested: ${summariseKeys(unexpected)}.`,
      detail: { unexpectedKeys: unexpected.length },
    });
  }

  const returned = new Set(kept.map((translation) => translation.key));
  for (const key of expected) {
    if (returned.has(key)) continue;
    issues.push({
      code: "provider-error",
      severity: "error",
      message: `The provider returned no translation for "${key}".`,
      key,
    });
  }

  return { translations: kept, issues };
}

function summariseKeys(keys: readonly string[]): string {
  const shown = keys.slice(0, MAX_REPORTED_KEYS);
  const extra = keys.length - shown.length;
  const body = shown.map((key) => `"${key}"`).join(", ");
  return extra > 0 ? `${body} (+${extra} more)` : body;
}

// ---------------------------------------------------------------------------
// Shape readers
// ---------------------------------------------------------------------------

/** Field aliases seen in the wild when a model paraphrases the schema. */
const LIST_FIELDS = ["translations", "results", "items", "strings", "data"];
const TARGET_FIELDS = ["target", "translation", "text", "value", "output"];
const KEY_FIELDS = ["key", "id", "name", "path"];

function collectEntries(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return null;

  for (const field of LIST_FIELDS) {
    const candidate = value[field];
    if (Array.isArray(candidate)) return candidate;
  }

  // A single object that is itself one translation.
  if (readEntry(value) !== null) return [value];

  // A flat `{ "key": "target" }` map — unambiguous as long as every value is a
  // string, which distinguishes it from an envelope we failed to recognise.
  const pairs = Object.entries(value);
  if (
    pairs.length > 0 &&
    pairs.every(([, entryValue]) => typeof entryValue === "string")
  ) {
    return pairs.map(([key, entryValue]) => ({ key, target: entryValue }));
  }

  return null;
}

function readEntry(entry: unknown): ProviderTranslation | null {
  if (!isRecord(entry)) return null;

  const key = firstString(entry, KEY_FIELDS);
  if (key === null || key.length === 0) return null;

  const target = firstString(entry, TARGET_FIELDS);
  // An empty string is a legitimate answer (the source may be empty); a missing
  // or non-string target is not.
  if (target === null) return null;

  const rationale = firstString(entry, ["rationale", "reason", "note"]);
  const translation: ProviderTranslation = { key, target };
  if (rationale !== null && rationale.trim().length > 0) {
    translation.rationale = rationale.trim();
  }
  return translation;
}

function firstString(
  record: Record<string, unknown>,
  fields: readonly string[],
): string | null {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string") return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Text recovery
// ---------------------------------------------------------------------------

/** Strip a BOM and any markdown code fences wrapping the payload. */
export function stripWrapper(raw: string): string {
  let text = raw.replace(/^﻿/, "").trim();

  // ```json … ``` — take the first fenced block that looks like JSON, since a
  // chatty model puts its explanation outside the fence.
  const fence = /```[ \t]*([a-zA-Z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    const body = (match[2] ?? "").trim();
    if (body.startsWith("{") || body.startsWith("[")) return body;
  }

  // An unterminated fence (the model hit its token limit mid-block).
  const opening = /```[ \t]*[a-zA-Z0-9_+-]*[ \t]*\r?\n/.exec(text);
  if (opening !== null) {
    const body = text.slice(opening.index + opening[0].length).trim();
    if (body.startsWith("{") || body.startsWith("[")) return body;
  }

  return text;
}

/**
 * Find and parse the outermost JSON value in `text`.
 *
 * Scans for the first `{` or `[` and walks to its matching close, tracking
 * string state so a brace inside a translated string cannot end the scan. If
 * strict parsing fails, retries once with trailing commas removed — by far the
 * most common single-character defect in generated JSON.
 */
export function extractJson(text: string): unknown {
  const start = firstStructuralIndex(text);
  if (start === -1) return undefined;

  const end = matchingCloseIndex(text, start);
  if (end === -1) return recoverTruncated(text.slice(start));

  const candidate = text.slice(start, end + 1);
  const direct = tryParse(candidate);
  if (direct.ok) return direct.value;

  const repaired = tryParse(stripTrailingCommas(candidate));
  if (repaired.ok) return repaired.value;

  return undefined;
}

/** How many trailing elements to discard before giving up on a cut-off response. */
const MAX_TRUNCATION_BACKTRACKS = 8;

/**
 * Recover a response the model ran out of tokens mid-way through.
 *
 * Closing the open scopes is enough when the cut landed between elements. When
 * it landed inside one, the half-written element has to go: backtrack to the
 * previous comma and try again. Everything the model *did* finish is kept,
 * which on a large batch is the difference between losing one string and losing
 * all forty.
 */
function recoverTruncated(text: string): unknown {
  let candidate = text;
  for (let i = 0; i < MAX_TRUNCATION_BACKTRACKS; i += 1) {
    const closed = closeOpenScopes(candidate);
    const direct = tryParse(closed);
    if (direct.ok) return direct.value;
    const repaired = tryParse(stripTrailingCommas(closed));
    if (repaired.ok) return repaired.value;

    const cut = lastCommaOutsideString(candidate);
    if (cut === -1) return undefined;
    candidate = candidate.slice(0, cut);
  }
  return undefined;
}

/** Index of the last `,` that is not inside a string literal, or -1. */
function lastCommaOutsideString(text: string): number {
  let inString = false;
  let escaped = false;
  let last = -1;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === undefined) break;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === ",") last = i;
  }
  return last;
}

function firstStructuralIndex(text: string): number {
  const brace = text.indexOf("{");
  const bracket = text.indexOf("[");
  if (brace === -1) return bracket;
  if (bracket === -1) return brace;
  return Math.min(brace, bracket);
}

/** Index of the close that balances the opener at `start`, or -1. */
function matchingCloseIndex(text: string, start: number): number {
  const opener = text[start];
  if (opener !== "{" && opener !== "[") return -1;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (char === undefined) break;

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Close any scopes left open by a truncated response. */
function closeOpenScopes(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === "}" || char === "]") stack.pop();
  }

  let out = text;
  if (inString) out += '"';
  // Drop a dangling `,` or `"key":` fragment before closing.
  out = out.replace(/,\s*$/u, "").replace(/,?\s*"[^"]*"\s*:\s*$/u, "");
  while (stack.length > 0) out += stack.pop();
  return out;
}

/** Remove `,` that immediately precedes `}` or `]`, ignoring string contents. */
export function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === undefined) break;

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === ",") {
      // Look ahead past whitespace for a closer.
      let j = i + 1;
      while (j < text.length && /\s/u.test(text[j] ?? "")) j += 1;
      const next = text[j];
      if (next === "}" || next === "]") continue; // drop the comma
    }
    out += char;
  }
  return out;
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

const PREVIEW_CHARS = 160;

function preview(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= PREVIEW_CHARS
    ? flat
    : `${flat.slice(0, PREVIEW_CHARS)}…`;
}

function providerError(
  message: string,
  detail: Record<string, string | number | boolean | null>,
  severity: Issue["severity"] = "error",
): Issue {
  return { code: "provider-error", severity, message, detail };
}
