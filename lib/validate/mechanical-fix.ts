import { extractPlaceholders } from "@/lib/core";
import {
  ALWAYS_SUSPECT_INVISIBLE,
  NBSP_LIKE,
  codePoints,
  isAllowedControl,
  isC0Control,
  isC1Control,
  leadingWhitespace,
  trailingWhitespace,
} from "./text";

/**
 * Deterministic repairs.
 *
 * A model call costs 300–2000ms and a slice of the budget. Roughly half of all
 * validation failures in practice are not linguistic at all — the model wrapped
 * its answer in a code fence, ate the leading space, or emitted a non-breaking
 * space inside `{count}`. Those have exactly one correct fix, and asking a
 * language model to apply it is both slower and less reliable than doing it
 * here.
 *
 * The hard constraint: **nothing in this file may change the linguistic
 * content**. Every transform either removes something that is provably not
 * language (a fence, a control byte) or restores something the source
 * prescribes (edge whitespace). Word choice, punctuation and casing are never
 * touched — those go back to the model.
 */

export type MechanicalFixKind =
  | "strip-code-fence"
  | "strip-wrapping-quotes"
  | "unescape-placeholder-braces"
  | "normalize-placeholder-spaces"
  | "strip-control-characters"
  | "strip-zero-width"
  | "collapse-double-spaces"
  | "restore-leading-whitespace"
  | "restore-trailing-whitespace";

export interface MechanicalFix {
  kind: MechanicalFixKind;
  /** One line, past tense, safe to show in the review table. */
  note: string;
}

export interface MechanicalFixResult {
  text: string;
  applied: MechanicalFix[];
  changed: boolean;
}

interface Step {
  kind: MechanicalFixKind;
  run: (source: string, target: string) => { text: string; note: string } | null;
}

/** Quote pairs a model may wrap around its answer. */
const QUOTE_PAIRS: ReadonlyArray<readonly [open: string, close: string]> = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"], // “ ”
  ["„", "“"], // „ “ (German)
  ["«", "»"], // « »
  ["‘", "’"], // ‘ ’
  ["「", "」"], // 「 」
  ["『", "』"], // 『 』
  ["`", "`"],
];

const FENCE = /^\s*```[A-Za-z0-9_-]*\r?\n?([\s\S]*?)\r?\n?```\s*$/;

/**
 * Strip a markdown code fence the model wrapped around a single string.
 *
 * Gated on the source not containing a fence itself — a locale file *can*
 * legitimately contain markdown in body copy.
 */
function stripCodeFence(source: string, target: string) {
  if (source.includes("```")) return null;
  const match = FENCE.exec(target);
  const inner = match?.[1];
  if (inner === undefined) return null;
  return { text: inner, note: "Removed a markdown code fence wrapped around the translation." };
}

/**
 * Strip quotation marks the model added around the whole answer.
 *
 * Three guards keep this from eating real punctuation: the source must not
 * already open with the same character, the pair must bracket the entire
 * string, and for symmetric quotes the interior must not contain the same
 * character (so `"He said "hi""` is left alone as genuinely ambiguous).
 */
function stripWrappingQuotes(source: string, target: string) {
  // If the source is itself a quoted string, the quotes are content — and the
  // translator is entitled to swap them for the target locale's convention
  // («…» in French, „…“ in German), so nothing here can be assumed spurious.
  const sourceTrimmed = source.trim();
  if (
    QUOTE_PAIRS.some(
      ([open, close]) =>
        sourceTrimmed.startsWith(open) && sourceTrimmed.endsWith(close),
    )
  ) {
    return null;
  }

  let text = target;
  let rounds = 0;
  // Models occasionally double-wrap ("\"text\""), so allow two passes.
  while (rounds < 2) {
    const trimmed = text.trim();
    if (trimmed.length < 2) break;
    const pair = QUOTE_PAIRS.find(
      ([open, close]) => trimmed.startsWith(open) && trimmed.endsWith(close),
    );
    if (pair === undefined) break;
    const [open, close] = pair;
    const inner = trimmed.slice(open.length, trimmed.length - close.length);
    if (inner.length === 0) break;
    if (open === close && inner.includes(open)) break;
    text = inner;
    rounds += 1;
  }
  if (rounds === 0) return null;
  return { text, note: "Removed quotation marks the model wrapped around the translation." };
}

/**
 * Undo over-escaped placeholder braces: `\{count\}` → `{count}`.
 *
 * Models trained on template code sometimes escape braces "for safety". The
 * escape is not part of JSON string syntax, so it would ship literally.
 */
function unescapePlaceholderBraces(source: string, target: string) {
  if (source.includes("\\{") || source.includes("\\}")) return null;
  if (!/\\[{}]/.test(target)) return null;
  const text = target.replace(/\\([{}])/g, "$1");
  if (text === target) return null;
  return { text, note: "Unescaped over-escaped placeholder braces." };
}

/**
 * Replace non-breaking / thin spaces *inside* placeholder delimiters.
 *
 * `{ count }` with a U+00A0 looks identical on screen and fails every runtime
 * interpolation lookup. Outside placeholders these characters are legitimate
 * typography (French punctuation spacing), so the rewrite is scoped to the
 * exact spans the extractor recognised.
 */
function normalizePlaceholderSpaces(_source: string, target: string) {
  const placeholders = extractPlaceholders(target);
  if (placeholders.length === 0) return null;

  let text = "";
  let cursor = 0;
  let changed = false;
  for (const p of placeholders) {
    text += target.slice(cursor, p.index);
    let raw = "";
    for (const { cp, char } of codePoints(p.raw)) {
      if (NBSP_LIKE.has(cp)) {
        raw += " ";
        changed = true;
      } else if (ALWAYS_SUSPECT_INVISIBLE.has(cp)) {
        changed = true; // dropped entirely
      } else {
        raw += char;
      }
    }
    text += raw;
    cursor = p.index + p.raw.length;
  }
  text += target.slice(cursor);
  if (!changed) return null;
  return {
    text,
    note: "Normalised non-breaking and invisible spaces inside placeholder delimiters.",
  };
}

/**
 * Remove C0/C1 control characters. Tab and newline survive; carriage return
 * survives only when the source uses it too.
 *
 * U+FFFD is deliberately NOT stripped: it is evidence that bytes were already
 * lost, and silently deleting it would let mojibake ship while the validator
 * reported a clean run.
 */
function stripControlCharacters(source: string, target: string) {
  const allowCr = source.includes("\r");
  let text = "";
  let removed = 0;
  for (const { cp, char } of codePoints(target)) {
    if (isAllowedControl(cp) || (cp === 0x0d && allowCr)) {
      text += char;
      continue;
    }
    if (isC0Control(cp) || isC1Control(cp)) {
      removed += 1;
      continue;
    }
    text += char;
  }
  if (removed === 0) return null;
  return { text, note: `Removed ${removed} control character(s).` };
}

/**
 * Remove always-invisible characters the source did not have.
 *
 * ZWJ (U+200D) and ZWNJ (U+200C) are excluded from the suspect set entirely:
 * they carry meaning in Persian, Arabic and Indic scripts and hold emoji
 * sequences together.
 */
function stripZeroWidth(source: string, target: string) {
  const sourceHas = new Set<number>();
  for (const { cp } of codePoints(source)) sourceHas.add(cp);

  let text = "";
  let removed = 0;
  for (const { cp, char } of codePoints(target)) {
    if (ALWAYS_SUSPECT_INVISIBLE.has(cp) && !sourceHas.has(cp)) {
      removed += 1;
      continue;
    }
    text += char;
  }
  if (removed === 0) return null;
  return { text, note: `Removed ${removed} zero-width character(s).` };
}

/**
 * Collapse runs of spaces the model introduced — but only when the source has
 * none, because some catalogues use double spaces for alignment on purpose.
 */
function collapseDoubleSpaces(source: string, target: string) {
  if (/ {2,}/.test(source)) return null;
  const text = target.replace(/ {2,}/g, " ");
  if (text === target) return null;
  return { text, note: "Collapsed repeated spaces introduced by the model." };
}

/**
 * Restore the source's edge whitespace.
 *
 * `"Hello, "` concatenated with a user name breaks the moment the trailing
 * space disappears, and no amount of prompting reliably preserves it.
 */
function restoreEdgeWhitespace(
  source: string,
  target: string,
  side: "leading" | "trailing",
) {
  if (source.trim().length === 0) return null;
  const core = target.trim();
  if (core.length === 0) return null; // emptiness is not a whitespace problem

  const expected =
    side === "leading" ? leadingWhitespace(source) : trailingWhitespace(source);
  const actual =
    side === "leading" ? leadingWhitespace(target) : trailingWhitespace(target);
  if (expected === actual) return null;

  const text =
    side === "leading"
      ? expected + core + trailingWhitespace(target)
      : leadingWhitespace(target) + core + expected;
  return {
    text,
    note:
      side === "leading"
        ? "Restored the source's leading whitespace."
        : "Restored the source's trailing whitespace.",
  };
}

/**
 * Order is deliberate: unwrap first (a fence hides everything inside it), then
 * repair placeholders, then remove junk characters, and only then restore edge
 * whitespace — because every earlier step can change what the edges are.
 */
const STEP_LIST: Step[] = [
  { kind: "strip-code-fence", run: stripCodeFence },
  { kind: "strip-wrapping-quotes", run: stripWrappingQuotes },
  { kind: "unescape-placeholder-braces", run: unescapePlaceholderBraces },
  { kind: "normalize-placeholder-spaces", run: normalizePlaceholderSpaces },
  { kind: "strip-control-characters", run: stripControlCharacters },
  { kind: "strip-zero-width", run: stripZeroWidth },
  { kind: "collapse-double-spaces", run: collapseDoubleSpaces },
  {
    kind: "restore-leading-whitespace",
    run: (source, target) => restoreEdgeWhitespace(source, target, "leading"),
  },
  {
    kind: "restore-trailing-whitespace",
    run: (source, target) => restoreEdgeWhitespace(source, target, "trailing"),
  },
];

const STEPS: readonly Step[] = Object.freeze(STEP_LIST);

/**
 * Apply every safe deterministic repair, reporting exactly which ones ran.
 *
 * Pure: the inputs are not mutated and the same inputs always yield the same
 * output. Idempotent by construction — running the result back through this
 * function applies nothing.
 */
export function applyMechanicalFixes(
  source: string,
  target: string,
): MechanicalFixResult {
  let text = target;
  const applied: MechanicalFix[] = [];

  for (const step of STEPS) {
    const result = step.run(source, text);
    if (result === null || result.text === text) continue;
    text = result.text;
    applied.push({ kind: step.kind, note: result.note });
  }

  return { text, applied, changed: text !== target };
}

/** One-line rollup for the review table and the job log. */
export function describeMechanicalFixes(
  applied: readonly MechanicalFix[],
): string {
  if (applied.length === 0) return "No mechanical fixes were needed.";
  return applied.map((fix) => fix.note).join(" ");
}
