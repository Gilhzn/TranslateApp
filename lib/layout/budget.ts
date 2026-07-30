/**
 * Length budgets.
 *
 * A budget answers one question: how much wider than the English source may
 * this translation get before the UI breaks? The answer is a *width* ceiling,
 * not a character ceiling — see `metrics.ts` for why character counts lie.
 *
 * Two failure modes have to be avoided simultaneously, and they pull in
 * opposite directions:
 *
 *   - Too generous  -> real overflow ships. Quality bar #1 violated.
 *   - Too tight     -> every German button is permanently "overflow", the
 *                      repair loop burns its attempt budget, and the engine
 *                      emits worse translations than a single pass would have.
 *
 * The blend below resolves that. See `effectiveRatio` and `absoluteHeadroom`.
 */

import type { LengthBudget, LocaleProfile, UiRole } from "@/lib/types";
import { isFullWidthScript } from "./locales";
import {
  estimateLongestLineWidth,
  measureText,
  round3,
  typicalCharWidth,
} from "./metrics";

// ---------------------------------------------------------------------------
// Role table
// ---------------------------------------------------------------------------

interface RoleSpec {
  /**
   * The ratio this role's chrome can absorb *before* considering the locale.
   * Derived from how the component is laid out, not from any language.
   */
  ratio: number;
  /**
   * How far we are willing to stretch this role to accommodate a genuinely
   * expansive locale. Caps the locale-driven half of the blend so a hostile
   * role never inherits e.g. body-copy generosity.
   */
  ceiling: number;
  /**
   * Multiplier above `allowedWidth` that is reported as "tight" (a shippable
   * warning) rather than "overflow". Wrapping roles get more slack because
   * being 10% long costs them a line, not a clipped word.
   */
  grace: number;
  /**
   * Asymptotic absolute allowance, in em, granted to a zero-width source.
   * This is what makes "OK" translatable: 1.2 x 1.4em is 1.68em, which no
   * language on earth can render "confirm" inside.
   */
  headroomEm: number;
  /**
   * Hard character ceiling implied by the chrome, or null when the component
   * wraps freely and no absolute cap is meaningful.
   */
  hardCap: number | null;
  /** Leading clause of the rationale; states *why* the role is constrained. */
  chrome: string;
}

/**
 * Ratios are calibrated against how each component actually fails:
 *  - `button` / `badge`: fixed-width chrome, text clips or forces a reflow of
 *    a toolbar row. The most dangerous roles in any UI.
 *  - `menu` / tabs: laid out on a shared horizontal track, so one long item
 *    pushes every sibling.
 *  - `label` / `placeholder`: bounded by a form column or an input's width.
 *  - `title` / `heading`: single line in a header, may wrap once.
 *  - `tooltip` / `error` / `toast` / `body`: wrap freely; length costs lines,
 *    not clipping, so they can be generous.
 */
const ROLE_SPECS: Readonly<Record<UiRole, RoleSpec>> = Object.freeze({
  button: {
    ratio: 1.2,
    ceiling: 1.35,
    grace: 1.06,
    // Calibrated against real short-button pairs: "Save" -> "Speichern" and
    // "Cancel" -> "Abbrechen" must pass (they are the correct translations and
    // have no shorter synonym), while "OK" -> "Registrierung abschliessen"
    // must not. Anything tighter makes the repair loop thrash on strings that
    // are already as short as German can express them.
    headroomEm: 4.0,
    hardCap: 32,
    chrome: "Button chrome is fixed-width and clips instead of wrapping",
  },
  badge: {
    ratio: 1.15,
    ceiling: 1.3,
    grace: 1.05,
    headroomEm: 2.2,
    hardCap: 16,
    chrome: "Badges are pill-shaped chrome sized tightly to the source text",
  },
  menu: {
    ratio: 1.25,
    ceiling: 1.4,
    grace: 1.08,
    // Single-word nav items are German's worst case by ratio:
    // "Settings" -> "Einstellungen" is 1.64x by width with no shorter
    // alternative in existence. The budget has to admit it.
    headroomEm: 4.5,
    hardCap: 40,
    chrome: "Menu and tab items share one horizontal track, so extra width pushes every sibling",
  },
  label: {
    ratio: 1.3,
    ceiling: 1.45,
    grace: 1.1,
    headroomEm: 3.6,
    hardCap: 56,
    chrome: "Form labels sit in a fixed-width column beside their field",
  },
  placeholder: {
    ratio: 1.3,
    ceiling: 1.45,
    grace: 1.1,
    headroomEm: 4.0,
    hardCap: 64,
    chrome: "Placeholder text is clipped by the input's width and never wraps",
  },
  title: {
    ratio: 1.35,
    ceiling: 1.5,
    grace: 1.1,
    headroomEm: 4.5,
    hardCap: 72,
    chrome: "Titles occupy a single line in headers and dialog bars",
  },
  heading: {
    ratio: 1.35,
    ceiling: 1.5,
    grace: 1.1,
    headroomEm: 5.0,
    hardCap: 88,
    chrome: "Headings may wrap once but should not reflow the section below them",
  },
  tooltip: {
    ratio: 1.6,
    ceiling: 1.75,
    grace: 1.15,
    headroomEm: 6.0,
    hardCap: null,
    chrome: "Tooltips wrap inside a floating panel and have room to breathe",
  },
  error: {
    ratio: 1.5,
    ceiling: 1.65,
    grace: 1.12,
    headroomEm: 5.5,
    hardCap: null,
    chrome: "Error text wraps under its field but must stay scannable at a glance",
  },
  toast: {
    ratio: 1.5,
    ceiling: 1.65,
    grace: 1.12,
    headroomEm: 5.5,
    hardCap: null,
    chrome: "Toasts wrap to about two lines before they start to look broken",
  },
  body: {
    ratio: 1.8,
    ceiling: 1.95,
    grace: 1.2,
    headroomEm: 8.0,
    hardCap: null,
    chrome: "Body copy wraps across as many lines as it needs",
  },
  unknown: {
    // Overwritten per-locale below; see UNKNOWN_MARGIN.
    ratio: 1.4,
    ceiling: 1.7,
    grace: 1.1,
    headroomEm: 4.5,
    hardCap: null,
    chrome: "The UI role of this string could not be determined",
  },
});

// `Object.freeze` above is shallow; freeze the specs themselves so `roleSpec()`
// can hand the table out to the UI without anyone being able to retune the
// engine at a distance.
for (const spec of Object.values(ROLE_SPECS)) Object.freeze(spec);

/**
 * Extra margin added on top of the locale's own expansion for strings whose
 * role we could not detect. We do not know what chrome holds them, so we track
 * the language rather than guess at the component.
 */
const UNKNOWN_MARGIN = 0.2;
const UNKNOWN_RATIO_FLOOR = 1.35;

/**
 * Half-life of the absolute headroom, in em. At a source width of
 * HEADROOM_HALF_LIFE the absolute allowance has decayed to half of the role's
 * `headroomEm`. 5em is roughly nine average Latin characters — the point where
 * ratio-based budgeting starts producing usable amounts of room on its own.
 */
const HEADROOM_HALF_LIFE = 5.0;

/** Same idea in character units, used only for the advisory `maxChars`. */
const HEADROOM_CHARS_MAX = 5;
const HEADROOM_CHARS_HALF_LIFE = 9;

// ---------------------------------------------------------------------------
// Core formulas
// ---------------------------------------------------------------------------

/** The role-driven ratio, with `unknown` resolved against the locale. */
function roleRatioFor(role: UiRole, profile: LocaleProfile): number {
  const spec = ROLE_SPECS[role];
  if (role !== "unknown") return spec.ratio;
  return Math.min(
    spec.ceiling,
    Math.max(UNKNOWN_RATIO_FLOOR, profile.expansion + UNKNOWN_MARGIN),
  );
}

/**
 * effectiveRatio = max(roleRatio, min(profile.expansion, roleCeiling))
 *
 * Read it as: "respect the component's constraint, but never demand something
 * the language cannot deliver — up to the point where the component would
 * actually break."
 *
 *   de + button : max(1.20, min(1.35, 1.35)) = 1.35  <- German gets its 35%
 *   fi + badge  : max(1.15, min(1.30, 1.30)) = 1.30
 *   ja + button : max(1.20, min(0.60, 1.35)) = 1.20  <- no penalty for being
 *                                                       naturally shorter
 *   de + body   : max(1.80, min(1.35, 1.95)) = 1.80
 *
 * Without the `max(roleRatio, ...)` term, Japanese buttons would be held to
 * 0.60x and every single one would be flagged. Without the
 * `min(expansion, ceiling)` term, German buttons would be held to 1.20x and
 * the repair loop would thrash on strings that are simply as short as German
 * can express them.
 */
export function effectiveRatioFor(
  role: UiRole,
  profile: LocaleProfile,
): number {
  const spec = ROLE_SPECS[role];
  return round3(
    Math.max(roleRatioFor(role, profile), Math.min(profile.expansion, spec.ceiling)),
  );
}

/**
 * Absolute allowance in em, on top of the source width.
 *
 * Ratios are meaningless on very short strings: "OK" is 1.40em, and 1.2x of
 * that is 1.68em — not enough for a single extra letter. Real UIs solve this
 * with padding and minimum widths, which is exactly what this models. The
 * allowance decays hyperbolically so it is decisive at 2 characters and
 * negligible by the time ratio-based room is plentiful.
 *
 *   button, "OK"        (1.40em) -> 3.0 * 5/(5+1.40) = 2.34em
 *   button, "Save file" (4.5em)  -> 3.0 * 5/(5+4.5)  = 1.58em
 *   button, 20 chars    (11em)   -> 3.0 * 5/(5+11)   = 0.94em (ratio dominates)
 */
export function absoluteHeadroomFor(role: UiRole, sourceWidth: number): number {
  const spec = ROLE_SPECS[role];
  return round3(
    (spec.headroomEm * HEADROOM_HALF_LIFE) /
      (HEADROOM_HALF_LIFE + Math.max(0, sourceWidth)),
  );
}

/**
 * The width, in em, a translation must come down to in order to pass.
 *
 *   allowedWidth = max(effectiveRatio * sourceWidth, sourceWidth + headroom)
 *
 * Exported because `LengthBudget` cannot express the absolute term — anything
 * that needs `TranslationUnit.allowedWidth` (the prompt engine) must call this
 * rather than multiplying `budget.maxRatio` by hand.
 */
export function allowedWidthFor(
  source: string,
  role: UiRole,
  profile: LocaleProfile,
): number {
  const sourceWidth = estimateLongestLineWidth(source, profile);
  return allowedWidthFromParts(sourceWidth, role, profile);
}

function allowedWidthFromParts(
  sourceWidth: number,
  role: UiRole,
  profile: LocaleProfile,
): number {
  const ratio = effectiveRatioFor(role, profile);
  return round3(
    Math.max(ratio * sourceWidth, sourceWidth + absoluteHeadroomFor(role, sourceWidth)),
  );
}

// ---------------------------------------------------------------------------
// Character ceiling (advisory)
// ---------------------------------------------------------------------------

/**
 * `maxChars` is *prompt guidance*, not the enforcement mechanism. Models
 * reason far better about "at most 18 characters" than about em widths, but a
 * character count cannot capture uppercase runs or mixed scripts, so
 * `evaluateFit` remains the sole authority on the verdict. Because of that
 * split the number here is allowed to be mildly conservative: aiming the model
 * a little short costs nothing, whereas aiming it long costs a repair round.
 */
function characterCeiling(
  source: string,
  role: UiRole,
  profile: LocaleProfile,
  allowedWidth: number,
): number {
  const spec = ROLE_SPECS[role];
  const measured = measureText(source, profile);
  const sourceChars = measured.charCount;

  // Expected mean advance of a *target* character. Half the locale's script
  // baseline, half the source's own mean — casing is usually preserved in
  // translation, so an ALL-CAPS source predicts an ALL-CAPS (wider) target.
  const scriptTypical = typicalCharWidth(profile);
  const sourceMean =
    measured.visibleCharCount > 0 && measured.width > 0
      ? measured.width / measured.visibleCharCount
      : scriptTypical;
  const avgTargetChar = clamp(0.5 * scriptTypical + 0.5 * sourceMean, 0.35, 2.2);

  const widthDerived = Math.floor(allowedWidth / avgTargetChar);

  // Floor: the number below which the instruction becomes unsatisfiable.
  const floorChars = isFullWidthScript(profile)
    ? // CJK genuinely uses fewer characters; granting Latin-style absolute
      // headroom here would tell the model it may write twice as much as it
      // should. Track the locale's own expansion instead.
      Math.max(2, Math.ceil(sourceChars * profile.expansion))
    : sourceChars + shortSourceCharHeadroom(sourceChars);

  const capped =
    spec.hardCap === null ? widthDerived : Math.min(spec.hardCap, widthDerived);

  return Math.max(1, floorChars, capped);
}

/**
 * Absolute character headroom for short sources, mirroring
 * `absoluteHeadroomFor` in character space: 4 extra characters for "OK",
 * 2 for a 12-character label, 1 for a sentence.
 */
function shortSourceCharHeadroom(sourceChars: number): number {
  return Math.max(
    1,
    Math.round(
      (HEADROOM_CHARS_MAX * HEADROOM_CHARS_HALF_LIFE) /
        (HEADROOM_CHARS_HALF_LIFE + sourceChars),
    ),
  );
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the budget for one string.
 *
 * `maxChars` is non-null only for roles whose chrome imposes a real ceiling.
 * Wrapping roles (body, tooltip, error, toast, unknown) get `null`, so that
 * downstream validators do not turn a paragraph's length into a hard error.
 */
export function budgetForRole(
  role: UiRole,
  sourceValue: string,
  profile: LocaleProfile,
): LengthBudget {
  const spec = ROLE_SPECS[role];
  const sourceWidth = estimateLongestLineWidth(sourceValue, profile);
  const maxRatio = effectiveRatioFor(role, profile);
  const allowedWidth = allowedWidthFromParts(sourceWidth, role, profile);
  const chars = characterCeiling(sourceValue, role, profile, allowedWidth);
  const maxChars = spec.hardCap === null ? null : chars;

  return {
    maxRatio,
    maxChars,
    graceRatio: spec.grace,
    rationale: buildRationale({
      role,
      profile,
      spec,
      maxRatio,
      chars,
      sourceWidth,
      allowedWidth,
      sourceChars: measureText(sourceValue, profile).charCount,
    }),
  };
}

/**
 * Everything a caller needs to size one string, computed once.
 * `TranslationUnit` wants both `budget` and `allowedWidth`; this hands over
 * both without measuring the source twice.
 */
export interface LengthPlan {
  budget: LengthBudget;
  /** Width the translation must come down to, in em. */
  allowedWidth: number;
  /** Widest line of the source, in em. */
  sourceWidth: number;
  /** Advisory character ceiling, always present even when `maxChars` is null. */
  suggestedMaxChars: number;
}

export function planLength(
  source: string,
  role: UiRole,
  profile: LocaleProfile,
): LengthPlan {
  const sourceWidth = estimateLongestLineWidth(source, profile);
  const allowedWidth = allowedWidthFromParts(sourceWidth, role, profile);
  return {
    budget: budgetForRole(role, source, profile),
    allowedWidth,
    sourceWidth,
    suggestedMaxChars: characterCeiling(source, role, profile, allowedWidth),
  };
}

// ---------------------------------------------------------------------------
// Rationale + prompt copy
// ---------------------------------------------------------------------------

function expansionClause(profile: LocaleProfile): string {
  const pct = Math.round((profile.expansion - 1) * 100);
  if (pct > 0) {
    return `${profile.name} averages about ${pct}% expansion over English`;
  }
  if (pct < 0) {
    const glyph = profile.glyphWidth >= 1.5 ? ` but each glyph is roughly ${profile.glyphWidth}x as wide` : "";
    return `${profile.name} uses about ${-pct}% fewer characters than English${glyph}`;
  }
  return `${profile.name} runs about the same length as English`;
}

function buildRationale(input: {
  role: UiRole;
  profile: LocaleProfile;
  spec: RoleSpec;
  maxRatio: number;
  chars: number;
  sourceWidth: number;
  allowedWidth: number;
  sourceChars: number;
}): string {
  const { spec, profile, maxRatio, chars, sourceWidth, allowedWidth } = input;
  const ratioDrivenWidth = maxRatio * sourceWidth;
  // Report which of the two terms actually decided the allowance, so the UI
  // explains a 2.6x-looking button budget instead of appearing inconsistent.
  const headroomWon = allowedWidth > ratioDrivenWidth + 0.001;

  const base = `${spec.chrome}; ${expansionClause(profile)}, so this string may grow to at most ${maxRatio.toFixed(2)}x its rendered width (about ${chars} characters).`;

  if (!headroomWon) return base;

  return `${base} The source is very short, so a fixed minimum allowance of ${round3(allowedWidth - sourceWidth).toFixed(2)}em applies instead — "OK" cannot be translated into 2.4 characters.`;
}

/**
 * Plain-language length instruction for the translation prompt.
 *
 * Consumed by the prompt engine; keep it one or two sentences, imperative, and
 * free of jargon the model has to decode. `role` is optional so the helper can
 * be called with nothing but the budget, but supplying it produces noticeably
 * sharper copy.
 */
export function describeBudgetForPrompt(
  budget: LengthBudget,
  profile: LocaleProfile,
  source: string,
  role?: UiRole,
): string {
  const sourceChars = measureText(source, profile).charCount;
  const spec = role === undefined ? undefined : ROLE_SPECS[role];

  const limit =
    budget.maxChars ??
    (role === undefined
      ? // No role and no hard cap: fall back to the ratio, which is all the
        // budget carries. Round up so the instruction is never below source.
        Math.max(sourceChars + 1, Math.ceil(sourceChars * budget.maxRatio))
      : characterCeiling(
          source,
          role,
          profile,
          allowedWidthFor(source, role, profile),
        ));

  const chrome =
    spec === undefined
      ? "longer text may be clipped or may reflow the surrounding layout"
      : lowerFirst(spec.chrome);

  const parts: string[] = [
    `Maximum ${limit} characters — ${chrome}.`,
    `The source is ${sourceChars} character${sourceChars === 1 ? "" : "s"}.`,
  ];

  if (profile.glyphWidth >= 1.5) {
    parts.push(
      `Count ${profile.name} characters, not bytes: each one renders about ${profile.glyphWidth}x as wide as a Latin letter, so the limit is already tight.`,
    );
  }
  if (budget.maxRatio <= 1.3 && sourceChars > 4) {
    parts.push(
      "Prefer a shorter synonym over an abbreviation, and never truncate mid-word.",
    );
  }

  return parts.join(" ");
}

function lowerFirst(text: string): string {
  const first = text.charAt(0);
  return first === "" ? text : first.toLowerCase() + text.slice(1);
}

/** Read-only view of the role table, for UI copy and tests. */
export function roleSpec(role: UiRole): Readonly<RoleSpec> {
  return ROLE_SPECS[role];
}
