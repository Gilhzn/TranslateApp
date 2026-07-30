/**
 * Text width estimation.
 *
 * `text.length` is the wrong unit for layout safety in two independent ways:
 *
 *   1. Within Latin script, advance widths differ by ~4x. "Illicit" and
 *      "Wowwww" are both 7 characters; the second is nearly twice as wide.
 *      Buttons clip on *width*, not on character count.
 *   2. Across scripts, one character is not one character. A CJK ideograph is
 *      a full em square — about 1.9-2.0x the advance of an average Latin
 *      letter — while Arabic and Hebrew letters run ~5% narrower.
 *
 * So we measure per code point against an advance table for a typical UI
 * sans-serif. The table is the mean of Inter and SF Pro Text advances at
 * regular weight, divided by units-per-em; Segoe UI and Roboto sit within a
 * few percent of these, which is well inside the noise of the expansion
 * heuristics that consume the result. Everything is returned in em, so the
 * numbers are font-size independent.
 *
 * Hard guarantee relied on by the fit engine: every code point has a
 * non-negative advance, so `estimateWidth` is monotonic — appending text can
 * never make a string measure narrower.
 */

import type { LocaleProfile } from "@/lib/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Advance of a full-width glyph, **in em**.
 *
 * This table has exactly one unit: the em, i.e. the font's advance divided by
 * its units-per-em ('a' = 0.55em in Inter/SF at regular weight). A CJK
 * ideograph, kana, Hangul syllable or fullwidth form is by definition designed
 * inside the em box — Unicode East Asian Width F/W — so its advance *is* one
 * em. U+FF21 FULLWIDTH LATIN CAPITAL A is the one-em-square variant of
 * U+0041 (0.66em); it cannot measure more than 1.0em.
 *
 * Used as a floor rather than a lookup, so a stray Japanese character inside a
 * German string is still measured honestly at a full em square, while a
 * Japanese profile (glyphWidth 1.95, i.e. 1.95 mean-Latin characters =
 * 1.0725em) is free to be marginally wider still.
 */
export const FULL_WIDTH_EM = 1.0;

/**
 * How many *average Latin characters* wide a full-width glyph is. This is the
 * unit `LocaleProfile.glyphWidth` is expressed in — a ratio, not an em value —
 * and it is what the prompt copy quotes to the model ("each character renders
 * about 1.95x as wide as a Latin letter").
 *
 * It exists only for documentation and copy. It must never be returned from
 * `charAdvance`: multiplying it by `MEAN_LATIN_ADVANCE` is what converts it
 * into this table's unit. Returning it raw measured every CJK code point ~1.9x
 * too wide, which made every ja/ko/zh budget unsatisfiable.
 */
export const FULL_WIDTH_GLYPH_RATIO = 1.9;

/**
 * Advance of a half-width katakana glyph (U+FF61..U+FF9F), in em. Half the em
 * box, by construction — that is what "half-width" names.
 */
const HALF_WIDTH_KANA_ADVANCE = 0.5;

/** Mean advance of a lowercase Latin letter — the "one character" baseline. */
export const MEAN_LATIN_ADVANCE = 0.55;

/**
 * Colour emoji render as a square roughly the size of the line box. 1.2em is
 * the effective advance in the common "emoji fallback inside a text run" case.
 */
const EMOJI_ADVANCE = 1.2;

/** Advance used for code points we have no better information about. */
const UNKNOWN_ADVANCE = 0.6;

// ---------------------------------------------------------------------------
// ASCII advance table
// ---------------------------------------------------------------------------

// Lowercase a..z. Note the extremes: i/j/l ~0.28, m 0.90.
const LOWERCASE_ADVANCE = [
  0.55, 0.57, 0.51, 0.57, 0.55, 0.34, 0.57, 0.56, 0.28, 0.28, 0.52, 0.28, 0.9,
  0.56, 0.57, 0.57, 0.57, 0.37, 0.49, 0.35, 0.56, 0.51, 0.79, 0.5, 0.51, 0.47,
] as const;

// Uppercase A..Z. Uppercase runs ~20% wider than lowercase overall, which is
// why an ALL-CAPS button label is a layout risk on its own.
const UPPERCASE_ADVANCE = [
  0.66, 0.65, 0.68, 0.7, 0.6, 0.58, 0.72, 0.72, 0.28, 0.52, 0.65, 0.56, 0.9,
  0.73, 0.75, 0.63, 0.75, 0.65, 0.62, 0.61, 0.71, 0.65, 0.99, 0.63, 0.61, 0.6,
] as const;

/** Digits are tabular in every UI face worth shipping: all the same advance. */
const DIGIT_ADVANCE = 0.55;

const PUNCTUATION_ADVANCE: Readonly<Record<string, number>> = {
  " ": 0.26,
  "!": 0.28,
  '"': 0.4,
  "#": 0.62,
  $: 0.57,
  "%": 0.9,
  "&": 0.68,
  "'": 0.22,
  "(": 0.33,
  ")": 0.33,
  "*": 0.45,
  "+": 0.58,
  ",": 0.26,
  "-": 0.34,
  ".": 0.26,
  "/": 0.42,
  ":": 0.26,
  ";": 0.26,
  "<": 0.58,
  "=": 0.58,
  ">": 0.58,
  "?": 0.5,
  "@": 1.05,
  "[": 0.31,
  "\\": 0.42,
  "]": 0.31,
  "^": 0.5,
  _: 0.45,
  "`": 0.35,
  "{": 0.35,
  "|": 0.28,
  "}": 0.35,
  "~": 0.58,
};

const ASCII_TABLE: Float64Array = (() => {
  const table = new Float64Array(128);
  // C0 controls and DEL have no advance. `\n` is handled by the callers, which
  // split on it before measuring.
  for (let i = 0; i < 128; i += 1) table[i] = 0;
  for (let i = 0; i < 26; i += 1) {
    table[0x61 + i] = LOWERCASE_ADVANCE[i] ?? MEAN_LATIN_ADVANCE;
    table[0x41 + i] = UPPERCASE_ADVANCE[i] ?? MEAN_LATIN_ADVANCE;
  }
  for (let i = 0; i < 10; i += 1) table[0x30 + i] = DIGIT_ADVANCE;
  for (const [char, width] of Object.entries(PUNCTUATION_ADVANCE)) {
    const cp = char.codePointAt(0);
    if (cp !== undefined && cp < 128) table[cp] = width;
  }
  // Tab advances, but its rendered width is context dependent; treat it as a
  // wide space rather than pretending it is free.
  table[0x09] = 1.0;
  return table;
})();

// ---------------------------------------------------------------------------
// Code point classification
// ---------------------------------------------------------------------------

type Range = readonly [number, number];

function inRanges(cp: number, ranges: readonly Range[]): boolean {
  // Linear scan: every table below is short, and this runs once per code point
  // on strings that are UI-sized (tens of characters), not documents.
  for (const [lo, hi] of ranges) {
    if (cp < lo) return false; // ranges are sorted ascending
    if (cp <= hi) return true;
  }
  return false;
}

/**
 * Marks and format characters that occupy no horizontal space: combining
 * diacritics, Hebrew points, Arabic harakat, Thai and Devanagari vowel signs,
 * variation selectors, ZWJ/ZWNJ and the bidi controls.
 */
const ZERO_WIDTH_RANGES: readonly Range[] = [
  [0x0300, 0x036f], // combining diacritical marks
  [0x0483, 0x0489], // Cyrillic combining
  [0x0591, 0x05bd], // Hebrew points
  [0x05bf, 0x05bf],
  [0x05c1, 0x05c2],
  [0x05c4, 0x05c5],
  [0x05c7, 0x05c7],
  [0x0610, 0x061a], // Arabic honorifics
  [0x061c, 0x061c], // Arabic letter mark
  [0x064b, 0x065f], // Arabic harakat
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x06df, 0x06e4],
  [0x06e7, 0x06e8],
  [0x06ea, 0x06ed],
  [0x0711, 0x0711],
  [0x0730, 0x074a],
  [0x07a6, 0x07b0],
  [0x0816, 0x0819],
  [0x081b, 0x0823],
  [0x0825, 0x0827],
  [0x0829, 0x082d],
  [0x0900, 0x0902], // Devanagari candrabindu/anusvara
  [0x093a, 0x093a],
  [0x093c, 0x093c],
  [0x0941, 0x0948], // Devanagari above/below-base matras
  [0x094d, 0x094d], // virama
  [0x0951, 0x0957],
  [0x0962, 0x0963],
  [0x0981, 0x0981],
  [0x09bc, 0x09bc],
  [0x09c1, 0x09c4],
  [0x09cd, 0x09cd],
  [0x0e31, 0x0e31], // Thai mai han akat
  [0x0e34, 0x0e3a], // Thai above/below vowels
  [0x0e47, 0x0e4e], // Thai tone marks
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f], // ZWSP, ZWNJ, ZWJ, LRM, RLM
  [0x202a, 0x202e], // bidi embedding controls
  [0x2060, 0x2064], // word joiner, invisible operators
  [0x2066, 0x206f], // bidi isolates, deprecated format chars
  [0x20d0, 0x20f0], // combining marks for symbols
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f], // combining half marks
  [0xfeff, 0xfeff], // BOM / ZWNBSP
];

/**
 * Full-width blocks. Everything here occupies one em square in a CJK face.
 */
const FULL_WIDTH_RANGES: readonly Range[] = [
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols & punctuation
  [0x3041, 0x33ff], // kana, Bopomofo, compat jamo, Kanbun, enclosed CJK
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff01, 0xff60], // fullwidth ASCII forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1b000, 0x1b16f], // kana supplement / extended
  [0x20000, 0x2fffd], // CJK Extension B-F
  [0x30000, 0x3fffd], // CJK Extension G+
];

/**
 * Pictographic ranges. Regional indicators are included so that a flag (a pair
 * of them) measures 2 x 0.6 = 1.2em, matching a single emoji.
 */
const EMOJI_RANGES: readonly Range[] = [
  [0x1f000, 0x1f0ff], // mahjong, dominoes, playing cards
  [0x1f100, 0x1f1e5], // enclosed alphanumeric supplement
  [0x1f300, 0x1f5ff], // misc symbols and pictographs
  [0x1f600, 0x1f64f], // emoticons
  [0x1f680, 0x1f6ff], // transport and map
  [0x1f900, 0x1faff], // supplemental symbols and pictographs
];

const REGIONAL_INDICATOR: Range = [0x1f1e6, 0x1f1ff];

/**
 * Dingbats and misc symbols that commonly render as emoji in UI strings
 * (✓ ✕ ★ ⚠ ➜). These are text-width in most faces, so they get a normal
 * advance rather than the emoji square.
 */
const SYMBOL_RANGES: readonly Range[] = [
  [0x2190, 0x21ff], // arrows
  [0x2200, 0x22ff], // mathematical operators
  [0x2300, 0x23ff], // misc technical (⌘, ⏎, ⏳)
  [0x25a0, 0x25ff], // geometric shapes
  [0x2600, 0x27bf], // misc symbols and dingbats
  [0x2b00, 0x2bff], // misc symbols and arrows
];

function isUppercaseLetter(cp: number): boolean {
  const ch = String.fromCodePoint(cp);
  const lower = ch.toLowerCase();
  // Uppercase iff it has a distinct lowercase form.
  return lower !== ch && lower.length === 1;
}

/**
 * Advance of a single code point, in em, measured for `profile`.
 *
 * Always >= 0. Callers rely on that for monotonicity.
 */
export function charAdvance(cp: number, profile: LocaleProfile): number {
  if (cp < 128) {
    return ASCII_TABLE[cp] ?? UNKNOWN_ADVANCE;
  }

  if (inRanges(cp, ZERO_WIDTH_RANGES)) return 0;

  if (inRanges(cp, FULL_WIDTH_RANGES)) {
    // `glyphWidth` counts average Latin characters, so it has to be converted
    // into em before it can be compared with anything else in this table.
    // A Latin profile (glyphWidth 1.0) yields 0.55em, below the em box, so the
    // floor is what makes a stray ideograph inside a German string honest.
    return Math.max(MEAN_LATIN_ADVANCE * profile.glyphWidth, FULL_WIDTH_EM);
  }

  // Halfwidth katakana / halfwidth Hangul: explicitly *not* full width.
  if (cp >= 0xff61 && cp <= 0xffdc) return HALF_WIDTH_KANA_ADVANCE;

  if (cp >= REGIONAL_INDICATOR[0] && cp <= REGIONAL_INDICATOR[1]) {
    return EMOJI_ADVANCE / 2;
  }
  if (inRanges(cp, EMOJI_RANGES)) return EMOJI_ADVANCE;

  // --- Scripts ------------------------------------------------------------
  // Latin-1 supplement & Latin Extended A/B and Additional: same metrics as
  // ASCII Latin, decided by case.
  if (
    (cp >= 0x00c0 && cp <= 0x024f) ||
    (cp >= 0x1e00 && cp <= 0x1eff) ||
    (cp >= 0x2c60 && cp <= 0x2c7f)
  ) {
    if (cp === 0x00d7 || cp === 0x00f7) return 0.58; // × ÷ are operators
    return isUppercaseLetter(cp) ? 0.68 : 0.56;
  }
  // Latin-1 punctuation and symbols (¡ ¢ £ © « ® ° ± ¿ …).
  if (cp >= 0x00a0 && cp <= 0x00bf) {
    return cp === 0x00a0 ? 0.26 : 0.55; // NBSP renders as a space
  }

  // Greek and Coptic + Greek Extended.
  if ((cp >= 0x0370 && cp <= 0x03ff) || (cp >= 0x1f00 && cp <= 0x1fff)) {
    return isUppercaseLetter(cp) ? 0.68 : 0.57;
  }

  // Cyrillic. Slightly wider than Latin on average: no narrow i/l equivalents.
  if ((cp >= 0x0400 && cp <= 0x052f) || (cp >= 0x2de0 && cp <= 0x2dff)) {
    return isUppercaseLetter(cp) ? 0.7 : 0.57;
  }

  // Hebrew (base letters; points were caught by ZERO_WIDTH_RANGES).
  if ((cp >= 0x0590 && cp <= 0x05ff) || (cp >= 0xfb1d && cp <= 0xfb4f)) {
    return 0.53;
  }

  // Arabic and its presentation forms.
  if (
    (cp >= 0x0600 && cp <= 0x06ff) ||
    (cp >= 0x0750 && cp <= 0x077f) ||
    (cp >= 0x08a0 && cp <= 0x08ff) ||
    (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff)
  ) {
    return 0.52;
  }

  // Thai: base consonants only (vowel signs are zero width above).
  if (cp >= 0x0e00 && cp <= 0x0e7f) return 0.54;

  // Indic scripts: base consonants carry wider forms than Latin.
  if (cp >= 0x0900 && cp <= 0x0dff) return 0.62;

  // General punctuation.
  if (cp >= 0x2000 && cp <= 0x206f) {
    if (cp <= 0x200a) return 0.26; // the various fixed-width spaces
    if (cp === 0x2013) return 0.5; // en dash
    if (cp === 0x2014) return 1.0; // em dash
    if (cp >= 0x2018 && cp <= 0x201f) return 0.3; // curly quotes
    if (cp === 0x2022) return 0.42; // bullet
    if (cp === 0x2026) return 0.85; // ellipsis
    if (cp === 0x2039 || cp === 0x203a) return 0.35; // single guillemets
    return 0.5;
  }
  // Currency symbols (€ ₽ ₹ ₪ ₩).
  if (cp >= 0x20a0 && cp <= 0x20cf) return 0.6;

  if (inRanges(cp, SYMBOL_RANGES)) return 0.85;

  return UNKNOWN_ADVANCE;
}

// ---------------------------------------------------------------------------
// String measurement
// ---------------------------------------------------------------------------

export interface TextMeasurement {
  /** Total advance of every code point, in em. Line breaks contribute 0. */
  width: number;
  /**
   * Advance of the widest line, in em. This is the box width the string
   * actually demands: an explicit `\n` resets the horizontal position, so a
   * two-line string is only as wide as its longer half.
   */
  longestLineWidth: number;
  /** Number of hard lines (always >= 1). */
  lineCount: number;
  /** Code points excluding line breaks. */
  charCount: number;
  /** Code points that actually consume horizontal space. */
  visibleCharCount: number;
}

const LINE_BREAK = /\r\n|[\n\r\u0085\u2028\u2029]/;

/**
 * Measure a string against a locale profile.
 *
 * This is the single measurement primitive; `estimateWidth` and
 * `estimateLongestLineWidth` are thin readers of its result.
 */
export function measureText(
  text: string,
  profile: LocaleProfile,
): TextMeasurement {
  const lines = text.split(LINE_BREAK);
  let total = 0;
  let longest = 0;
  let charCount = 0;
  let visibleCharCount = 0;

  for (const line of lines) {
    let lineWidth = 0;
    for (const char of line) {
      const cp = char.codePointAt(0);
      if (cp === undefined) continue;
      const advance = charAdvance(cp, profile);
      lineWidth += advance;
      charCount += 1;
      if (advance > 0) visibleCharCount += 1;
    }
    total += lineWidth;
    if (lineWidth > longest) longest = lineWidth;
  }

  return {
    width: round3(total),
    longestLineWidth: round3(longest),
    lineCount: lines.length,
    charCount,
    visibleCharCount,
  };
}

/**
 * Estimated rendered width of `text` in em.
 *
 * Monotonic by construction: every code point contributes a non-negative
 * advance, so appending can never shrink the result.
 */
export function estimateWidth(text: string, profile: LocaleProfile): number {
  return measureText(text, profile).width;
}

/**
 * Width of the widest hard line — the width the string's container must have.
 * Equal to `estimateWidth` for single-line strings.
 */
export function estimateLongestLineWidth(
  text: string,
  profile: LocaleProfile,
): number {
  return measureText(text, profile).longestLineWidth;
}

/**
 * Mean advance of the code points in `text`, in em. Used to convert an em
 * overflow into an actionable "cut N characters" number: cutting characters
 * from a Japanese string buys ~2em each, from an English one ~0.55em.
 *
 * Returns the profile's typical character width for empty / invisible input so
 * callers never have to guard against division by zero.
 */
export function averageCharWidth(
  text: string,
  profile: LocaleProfile,
): number {
  const measured = measureText(text, profile);
  if (measured.visibleCharCount === 0 || measured.width <= 0) {
    return typicalCharWidth(profile);
  }
  return measured.width / measured.visibleCharCount;
}

/**
 * An ordinary lowercase letter of each script, by language subtag.
 *
 * `LocaleProfile.glyphWidth` is one scalar per locale, but `charAdvance`
 * classifies per script, and the two only agree to within a few hundredths.
 * Rather than restate the advances here — restating them is exactly how the
 * table and the budget drifted apart — each entry names a letter and the real
 * advance is read back out of `charAdvance`. Anything not listed falls through
 * to the profile-derived value, which is correct for Latin (0.55em) and
 * conservative elsewhere.
 */
const SCRIPT_SAMPLE_LETTER: Readonly<Record<string, string>> = {
  // Cyrillic and Greek measure 0.57em, above the 0.55em Latin baseline their
  // glyphWidth of 1.0 implies. Understating them by 0.02em is enough to
  // advertise a `maxChars` that `evaluateFit` then calls "tight".
  ru: "е",
  uk: "е",
  be: "е",
  bg: "е",
  sr: "е",
  mk: "е",
  kk: "е",
  ky: "е",
  mn: "е",
  tg: "е",
  el: "α",
  // Hebrew letters are 0.53em, marginally above the 0.523em the RTL glyph
  // width implies.
  he: "ש",
  yi: "ש",
  ar: "م",
  fa: "م",
  ur: "م",
  ps: "م",
  ckb: "م",
  ug: "م",
  th: "ก",
  hi: "क",
  mr: "क",
  ne: "क",
  bn: "ক",
  ta: "க",
};

/**
 * The advance a "typical" character of this locale's script occupies, in em.
 *
 *   Latin          (glyphWidth 1.0)  -> 0.55em
 *   Cyrillic/Greek (glyphWidth 1.0)  -> 0.57em  (via the sample letter)
 *   Arabic/Hebrew  (glyphWidth 0.95) -> ~0.53em
 *   Indic          (glyphWidth 1.13) -> 0.62em
 *   CJK            (glyphWidth 1.95) -> 1.073em, i.e. 1.95 mean Latin letters
 *
 * Note the CJK line: `glyphWidth` is a count of *average Latin characters*,
 * not an em value, so it has to be multiplied by `MEAN_LATIN_ADVANCE` exactly
 * like it is inside `charAdvance`. Returning it raw was a unit error that
 * measured every CJK string ~1.9x too wide.
 *
 * These must stay in step with `charAdvance` — `budget.ts` divides an allowed
 * width by this number to advertise a character limit to the model, so any
 * script where this reads narrower than the table actually measures produces a
 * limit that `evaluateFit` will then reject. Hence `Math.max`: the answer is
 * allowed to be conservative, never optimistic.
 */
export function typicalCharWidth(profile: LocaleProfile): number {
  const derived = MEAN_LATIN_ADVANCE * profile.glyphWidth;
  const language = profile.code.split("-")[0]?.toLowerCase() ?? "";
  const sample = SCRIPT_SAMPLE_LETTER[language];
  const sampleCp = sample === undefined ? undefined : sample.codePointAt(0);
  const measured =
    sampleCp === undefined ? 0 : charAdvance(sampleCp, profile);
  return round3(Math.max(derived, measured));
}

/**
 * Round to 3 decimals. Widths are reported to the UI and serialised into JSON
 * responses, so they must be stable and free of float dust; 0.001em is three
 * orders of magnitude below anything that can affect a layout decision.
 */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
