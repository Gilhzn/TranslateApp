/**
 * The fit engine.
 *
 * `evaluateFit` is the single authority on whether a translation is safe to
 * ship. Everything else in this module — budgets, metrics, locale profiles —
 * exists to feed it.
 *
 * Two properties are load-bearing and are tested as properties, not examples:
 *
 *   1. If `targetWidth <= allowedWidth` the verdict is always "fits". The
 *      engine never flags a string that demonstrably fits; false positives are
 *      what make length enforcement get switched off in real projects.
 *   2. Width measurement is monotonic (see `metrics.ts`), so shortening a
 *      translation can never make its verdict worse. That is what lets the
 *      repair loop converge instead of oscillating.
 */

import type {
  FitResult,
  FitVerdict,
  LengthBudget,
  LocaleProfile,
  UiRole,
} from "@/lib/types";
import { allowedWidthFor, budgetForRole } from "./budget";
import {
  averageCharWidth,
  charAdvance,
  estimateLongestLineWidth,
  round3,
} from "./metrics";

const LINE_BREAK_CHARS: ReadonlySet<string> = new Set([
  "\n",
  "\r",
  "\u0085",
  "\u2028",
  "\u2029",
]);

/**
 * Ratios are surfaced in JSON responses, so they must stay finite —
 * `JSON.stringify(Infinity)` is `null`, which would break the review table.
 * A translation 99x the width of its source is already maximally broken.
 */
const MAX_REPORTED_RATIO = 99;

/** Advance of the horizontal ellipsis in the metrics table. */
const ELLIPSIS_WIDTH = 0.85;
const ELLIPSIS = "…";

/**
 * Evaluate whether `target` fits where `source` lives.
 *
 * Widths are measured as the *widest hard line* of each string. A `\n` resets
 * the horizontal position, so a two-line string only demands the width of its
 * longer half — which is exactly the rule body copy needs (requirement F) and
 * is equally correct for every other role.
 *
 * Both strings are measured with the *target* profile. Measurement is
 * per code point, so a Latin source measures identically under any profile;
 * passing the target profile only matters when the source itself contains
 * full-width characters, where using the target's glyph width is the right
 * call anyway.
 */
export function evaluateFit(
  source: string,
  target: string,
  role: UiRole,
  profile: LocaleProfile,
): FitResult {
  const budget = budgetForRole(role, source, profile);
  const sourceWidth = estimateLongestLineWidth(source, profile);
  const targetWidth = estimateLongestLineWidth(target, profile);
  const allowedWidth = allowedWidthFor(source, role, profile);

  const verdict = verdictFor(targetWidth, allowedWidth, budget.graceRatio);

  return {
    verdict,
    sourceWidth,
    targetWidth,
    ratio: reportedRatio(sourceWidth, targetWidth),
    budget,
    allowedWidth,
    overBy: charactersToCut(target, targetWidth, allowedWidth, verdict, profile),
  };
}

/**
 * "fits"     targetWidth <= allowedWidth
 * "tight"    allowedWidth < targetWidth <= allowedWidth * graceRatio
 * "overflow" beyond that
 *
 * All three comparisons run on the same rounded values that are reported in
 * the result, so a consumer re-checking `targetWidth <= allowedWidth` can never
 * disagree with the verdict.
 */
export function verdictFor(
  targetWidth: number,
  allowedWidth: number,
  graceRatio: number,
): FitVerdict {
  if (targetWidth <= allowedWidth) return "fits";
  if (targetWidth <= round3(allowedWidth * graceRatio)) return "tight";
  return "overflow";
}

function reportedRatio(sourceWidth: number, targetWidth: number): number {
  if (sourceWidth <= 0) {
    // An empty source can only be matched by an empty target.
    return targetWidth <= 0 ? 1 : MAX_REPORTED_RATIO;
  }
  return round3(Math.min(MAX_REPORTED_RATIO, targetWidth / sourceWidth));
}

/**
 * How many characters to cut, derived from the *target's own* mean advance.
 *
 * A constant would be actively misleading across scripts: 2em of overflow is
 * about four Latin characters but only one Japanese one. Using the target's
 * measured mean makes the number directly actionable in the repair prompt.
 */
function charactersToCut(
  target: string,
  targetWidth: number,
  allowedWidth: number,
  verdict: FitVerdict,
  profile: LocaleProfile,
): number {
  if (verdict === "fits") return 0;
  const excess = targetWidth - allowedWidth;
  if (excess <= 0) return 0;
  const meanChar = averageCharWidth(target, profile);
  if (meanChar <= 0) return 0;
  return Math.max(1, Math.ceil(excess / meanChar));
}

// ---------------------------------------------------------------------------
// Repair guidance
// ---------------------------------------------------------------------------

/**
 * Feedback handed back to the model when a translation misses its budget.
 * Concrete and quantified — "shorten it" produces another random guess,
 * "cut at least 4 characters, target 18" converges.
 */
export function describeFitForRepair(
  fit: FitResult,
  profile: LocaleProfile,
): string {
  if (fit.verdict === "fits") {
    return "The previous translation fitted its budget.";
  }

  const cap = fit.budget.maxChars;
  const severity =
    fit.verdict === "overflow"
      ? "is too long and will break the layout"
      : "only just fits and leaves no room for longer plural forms";

  const parts: string[] = [
    `The previous translation ${severity}: it renders at ${fit.targetWidth.toFixed(2)}em against a limit of ${fit.allowedWidth.toFixed(2)}em (${fit.ratio.toFixed(2)}x the source).`,
    `Cut at least ${fit.overBy} more character${fit.overBy === 1 ? "" : "s"}.`,
  ];

  if (cap !== null) {
    parts.push(`Stay at or under ${cap} characters.`);
  }
  if (profile.glyphWidth >= 1.5) {
    parts.push(
      `Remember that each ${profile.name} character is about ${profile.glyphWidth}x the width of a Latin letter.`,
    );
  }
  parts.push(
    "Use a shorter synonym or drop a redundant word; keep every placeholder exactly as it appears.",
  );

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Structural enforcement (last resort)
// ---------------------------------------------------------------------------

export interface TruncateOptions {
  /**
   * Substrings that must never be split or partially emitted — placeholders,
   * ICU arguments, markup tags. If a cut would land inside one, the cut moves
   * back to before it.
   */
  preserve?: readonly string[];
  /** Ellipsis to append. Pass "" to hard-clip. Defaults to "…". */
  ellipsis?: string;
}

export interface TruncationResult {
  text: string;
  /** True when the input had to be shortened. */
  truncated: boolean;
  /** Width of `text`, in em. */
  width: number;
}

/**
 * Clip `text` to `allowedWidth`, returning a string that provably measures
 * within budget.
 *
 * This is the mechanism behind quality bar #1: a translation that survives
 * every repair attempt and still overflows can be reduced here rather than
 * shipped broken. It is deliberately a last resort — the repair loop should
 * almost always beat it — but its existence is what makes overflow
 * unrepresentable in the output rather than merely reported.
 *
 * Cut safety:
 *   - cuts land on code point boundaries (surrogate pairs stay intact);
 *   - a combining mark is never separated from its base character;
 *   - for scripts with word breaks the cut retreats to the last space, unless
 *     that would discard more than two thirds of the available width;
 *   - a cut never lands inside a `preserve` span.
 */
export function truncateToWidth(
  text: string,
  allowedWidth: number,
  profile: LocaleProfile,
  options: TruncateOptions = {},
): TruncationResult {
  const ellipsis = options.ellipsis ?? ELLIPSIS;
  const currentWidth = estimateLongestLineWidth(text, profile);
  if (currentWidth <= allowedWidth) {
    return { text, truncated: false, width: currentWidth };
  }

  const ellipsisWidth =
    ellipsis === ELLIPSIS
      ? ELLIPSIS_WIDTH
      : estimateLongestLineWidth(ellipsis, profile);
  const contentBudget = allowedWidth - ellipsisWidth;
  if (contentBudget <= 0) {
    // Not even the ellipsis fits; emit nothing rather than something wider
    // than the box.
    return { text: "", truncated: true, width: 0 };
  }

  // Build the longest code point prefix whose widest line stays inside
  // contentBudget.
  const cuts: number[] = []; // char offsets at which a cut is legal
  let width = 0;
  let offset = 0;
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp === undefined) break;
    if (LINE_BREAK_CHARS.has(char)) {
      // A hard break resets the horizontal position, so the budget resets too.
      cuts.push(offset);
      width = 0;
      offset += char.length;
      continue;
    }
    const next = charAdvance(cp, profile);
    if (next > 0) {
      // A zero-width mark belongs to the character before it, so only record a
      // legal cut immediately *before* a character that occupies space.
      cuts.push(offset);
    }
    if (width + next > contentBudget) break;
    width += next;
    offset += char.length;
  }
  cuts.push(offset);

  let cut = offset;

  // Retreat out of any preserved span the cut landed inside.
  const preserve = options.preserve ?? [];
  for (const span of preserve) {
    if (span.length === 0) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(span, from);
      if (at === -1) break;
      if (cut > at && cut < at + span.length) cut = at;
      from = at + span.length;
    }
  }

  // Prefer a word boundary where the script has one. The one-third guard stops
  // a long unbreakable word from collapsing the whole string to its first
  // syllable: retreating past two thirds of the budget wastes more space than
  // a mid-word cut costs in legibility.
  if (!profile.noWordBreaks) {
    const lastSpace = text.lastIndexOf(" ", Math.max(0, cut - 1));
    if (lastSpace > 0 && lastSpace >= cut / 3) cut = lastSpace;
  }

  // Snap back to a legal code point boundary at or below `cut`.
  let safeCut = 0;
  for (const candidate of cuts) {
    if (candidate <= cut) safeCut = candidate;
    else break;
  }

  const clipped = text.slice(0, safeCut).replace(/\s+$/u, "");
  const result = clipped.length === 0 ? ellipsis : clipped + ellipsis;
  const resultWidth = estimateLongestLineWidth(result, profile);

  // Belt and braces: the construction above cannot exceed the budget, but the
  // whole point of this function is that its postcondition holds
  // unconditionally, so verify rather than assert.
  if (resultWidth > allowedWidth) {
    const bare = estimateLongestLineWidth(ellipsis, profile);
    return bare <= allowedWidth
      ? { text: ellipsis, truncated: true, width: bare }
      : { text: "", truncated: true, width: 0 };
  }

  return { text: result, truncated: true, width: resultWidth };
}

/**
 * Convenience wrapper: clip a translation to the budget its role implies.
 * Returns the original string untouched whenever it already fits.
 */
export function enforceFit(
  source: string,
  target: string,
  role: UiRole,
  profile: LocaleProfile,
  options: TruncateOptions = {},
): TruncationResult {
  return truncateToWidth(
    target,
    allowedWidthFor(source, role, profile),
    profile,
    options,
  );
}

/** The budget that `evaluateFit` would apply, without needing a translation. */
export function budgetFor(
  source: string,
  role: UiRole,
  profile: LocaleProfile,
): LengthBudget {
  return budgetForRole(role, source, profile);
}
