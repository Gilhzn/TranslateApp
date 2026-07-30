/**
 * Character-level primitives shared by the validators and the mechanical
 * fixer.
 *
 * Everything here works on Unicode code points, not UTF-16 units: a locale
 * file that contains emoji or astral CJK must not be mis-measured or
 * mis-sliced, and `"👍".length === 2` is exactly the kind of bug that ships a
 * lone surrogate into a JSON file.
 */

/** Space characters that are visually a space but are not U+0020. */
export const NBSP_LIKE = new Set<number>([
  0x00a0, // NO-BREAK SPACE
  0x202f, // NARROW NO-BREAK SPACE
  0x2007, // FIGURE SPACE
  0x2009, // THIN SPACE
]);

/**
 * Invisible characters that are always suspect in UI copy.
 *
 * ZWJ (U+200D) and ZWNJ (U+200C) are deliberately NOT in this set: they are
 * orthographically required in Persian, Arabic and Indic scripts, and they
 * hold emoji sequences together (👨‍👩‍👦). Stripping them would corrupt real
 * translations, so they get a context-sensitive check instead.
 */
export const ALWAYS_SUSPECT_INVISIBLE = new Set<number>([
  0x200b, // ZERO WIDTH SPACE
  0x2060, // WORD JOINER
  0xfeff, // ZERO WIDTH NO-BREAK SPACE / BOM
  0x180e, // MONGOLIAN VOWEL SEPARATOR (deprecated, format char)
]);

/** Context-sensitive joiners. */
export const JOINERS = new Set<number>([0x200c, 0x200d]);

export const REPLACEMENT_CHARACTER = 0xfffd;

/**
 * Languages whose orthography uses ZWJ/ZWNJ. A stray joiner in these locales
 * is far more likely to be correct than accidental.
 */
const JOINER_LANGUAGES = new Set([
  "ar", "fa", "ur", "ps", "ku", "sd", "ug", "ks",
  "hi", "bn", "gu", "pa", "kn", "ml", "mr", "ne", "or", "si", "ta", "te",
  "as", "my", "km", "bo", "dv",
]);

/**
 * Languages written in scripts with no case distinction. Casing checks are
 * meaningless there — "ALL CAPS" cannot be expressed in Japanese, and Georgian
 * Mkhedruli has no capitals either. Armenian, Greek and Cyrillic are cased and
 * therefore deliberately absent.
 */
const CASELESS_LANGUAGES = new Set([
  "ja", "zh", "ko", "th", "lo", "km", "my", "bo", "dz",
  "ar", "fa", "ur", "ps", "sd", "ug", "he", "yi", "dv", "am", "ti",
  "hi", "bn", "gu", "pa", "kn", "ml", "mr", "ne", "or", "si", "ta", "te", "as",
  "ka",
]);

/**
 * Languages that capitalise common nouns as a matter of orthography. A German
 * button reading "Datei Speichern" is not "Title Case styling" — it is just
 * German — so title-case drift detection would be pure noise there.
 */
const NOUN_CAPITALISING_LANGUAGES = new Set(["de", "lb", "gsw", "bar"]);

/** Primary language subtag, lowercased. `"pt-BR"` → `"pt"`. */
export function baseLanguage(code: string | undefined | null): string {
  if (!code) return "";
  const head = code.split(/[-_]/)[0];
  return (head ?? "").toLowerCase();
}

export function localeUsesJoiners(code: string | undefined | null): boolean {
  return JOINER_LANGUAGES.has(baseLanguage(code));
}

export function isCaselessLanguage(code: string | undefined | null): boolean {
  return CASELESS_LANGUAGES.has(baseLanguage(code));
}

export function capitalisesNouns(code: string | undefined | null): boolean {
  return NOUN_CAPITALISING_LANGUAGES.has(baseLanguage(code));
}

/** Same primary language, ignoring region/script. `"en"` vs `"en-GB"` → true. */
export function sameLanguage(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  const left = baseLanguage(a);
  const right = baseLanguage(b);
  return left.length > 0 && left === right;
}

export function isC0Control(cp: number): boolean {
  return cp <= 0x1f;
}

export function isC1Control(cp: number): boolean {
  return cp >= 0x80 && cp <= 0x9f;
}

/** Code points that may legally appear in a JSON-carried UI string. */
export function isAllowedControl(cp: number): boolean {
  return cp === 0x09 || cp === 0x0a;
}

/**
 * Bidirectional formatting characters. Legitimate — and sometimes mandatory —
 * in RTL locales where a placeholder sits next to Latin text, so they are
 * never flagged.
 */
export function isBidiControl(cp: number): boolean {
  return (
    cp === 0x200e ||
    cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
}

/** Rough emoji/pictograph test, used to spare legitimate ZWJ sequences. */
export function isEmojiLike(cp: number): boolean {
  return (
    cp === 0xfe0f ||
    cp === 0xfe0e ||
    cp === 0x20e3 ||
    (cp >= 0x2190 && cp <= 0x2bff) ||
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x1f1e6 && cp <= 0x1f1ff)
  );
}

export interface CodePointAt {
  cp: number;
  /** UTF-16 index, so `slice` on the same string stays valid. */
  index: number;
  char: string;
}

/** Iterate code points with their UTF-16 offsets. */
export function codePoints(value: string): CodePointAt[] {
  const out: CodePointAt[] = [];
  let index = 0;
  for (const char of value) {
    const cp = char.codePointAt(0);
    if (cp !== undefined) out.push({ cp, index, char });
    index += char.length;
  }
  return out;
}

/** `U+00A0` style rendering for messages and machine detail fields. */
export function formatCodePoint(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

const LEADING_WS = /^\s*/;
const TRAILING_WS = /\s*$/;

export function leadingWhitespace(value: string): string {
  return LEADING_WS.exec(value)?.[0] ?? "";
}

/**
 * For an all-whitespace string the entire run is reported as *leading* and the
 * trailing run is empty, so `leading + core + trailing` reconstructs the
 * original exactly instead of double-counting.
 */
export function trailingWhitespace(value: string): string {
  if (value.trim().length === 0) return "";
  return TRAILING_WS.exec(value)?.[0] ?? "";
}

/** Render whitespace so a diff message is readable: `" \t"` → `"·⇥"`. */
export function visualizeWhitespace(value: string): string {
  if (value.length === 0) return "(none)";
  let out = "";
  for (const { cp } of codePoints(value)) {
    if (cp === 0x20) out += "·";
    else if (cp === 0x09) out += "⇥";
    else if (cp === 0x0a) out += "⏎";
    else if (cp === 0x0d) out += "␍";
    else out += `[${formatCodePoint(cp)}]`;
  }
  return out;
}

const HAS_LETTER = /\p{L}/u;
const HAS_CASED = /\p{Lu}|\p{Ll}|\p{Lt}/u;

export function hasLetters(value: string): boolean {
  return HAS_LETTER.test(value);
}

export function hasCasedLetters(value: string): boolean {
  return HAS_CASED.test(value);
}

/**
 * True when every cased letter is uppercase and there are at least two of
 * them. The two-letter floor keeps single-letter labels ("X", "N") out of the
 * ALL-CAPS class, where the "style" reading is indistinguishable from an
 * ordinary capitalised word.
 */
export function isAllCaps(value: string): boolean {
  let cased = 0;
  for (const { char } of codePoints(value)) {
    const lower = char.toLowerCase();
    const upper = char.toUpperCase();
    if (lower === upper) continue; // caseless code point
    cased += 1;
    if (char !== upper) return false;
  }
  return cased >= 2;
}

/** Words split on whitespace, with empties dropped. */
export function words(value: string): string[] {
  return value.split(/\s+/u).filter((w) => w.length > 0);
}

/** First cased character of a string, or `null` when there is none. */
export function firstCasedChar(value: string): string | null {
  for (const { char } of codePoints(value)) {
    if (char.toLowerCase() !== char.toUpperCase()) return char;
  }
  return null;
}

export function startsUppercase(value: string): boolean {
  const first = firstCasedChar(value);
  return first !== null && first === first.toUpperCase();
}

/** Number of whitespace-separated words whose first cased letter is uppercase. */
export function capitalisedWordCount(value: string): number {
  let count = 0;
  for (const word of words(value)) {
    if (startsUppercase(word)) count += 1;
  }
  return count;
}
