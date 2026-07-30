/**
 * Deterministic random helpers shared by the property tests in this directory.
 *
 * Property tests only earn their keep if a failure is reproducible, so this
 * uses a seeded PRNG rather than `Math.random`. Kept in a plain module (not a
 * `.test.ts`) so every spec file can import it without Vitest trying to
 * collect it as a suite.
 */

import type { LocaleProfile } from "@/lib/types";

/** mulberry32 — small, fast, well-distributed for test-sized sample counts. */
export function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Alphabet deliberately mixes every width class the metrics table handles:
 * narrow Latin, wide Latin, digits, punctuation, space, accented Latin,
 * Cyrillic, Greek, Hebrew, Arabic, Thai, Devanagari, kana, ideographs, Hangul,
 * fullwidth forms, an emoji, and a combining mark.
 */
export const SAMPLE_CHARS: readonly string[] = [
  "i",
  "l",
  "m",
  "W",
  "a",
  "Z",
  "7",
  ".",
  "-",
  "(",
  " ",
  "@",
  "%",
  "é",
  "Ü",
  "ß",
  "Д",
  "ж",
  "Ω",
  "ω",
  "א",
  "ש",
  "ع",
  "ب",
  "ก",
  "ท",
  "क",
  "म",
  "あ",
  "カ",
  "漢",
  "字",
  "한",
  "국",
  "Ａ",
  "、",
  "😀",
  "\u0301", // combining acute — zero width
  "\u200b", // ZWSP — zero width
];

/** Characters that consume horizontal space (used for monotonicity tests). */
export const NON_COMBINING_SAMPLE_CHARS: readonly string[] =
  SAMPLE_CHARS.filter((c) => c !== "\u0301" && c !== "\u200b");

export function pick<T>(random: () => number, items: readonly T[]): T {
  const index = Math.min(items.length - 1, Math.floor(random() * items.length));
  const value = items[index];
  if (value === undefined) {
    throw new Error("pick() called with an empty array");
  }
  return value;
}

export function randomString(
  random: () => number,
  maxLength: number,
  alphabet: readonly string[] = SAMPLE_CHARS,
): string {
  const length = Math.floor(random() * (maxLength + 1));
  let out = "";
  for (let i = 0; i < length; i += 1) out += pick(random, alphabet);
  return out;
}

/**
 * One representative letter of the script `profile` is written in.
 *
 * Used to build the most charitable translation a model could possibly return
 * at a stated character limit — `maxChars` copies of an ordinary letter of the
 * target script, with no wide capitals and no punctuation. If even that string
 * overflows, the limit the module advertised was never satisfiable.
 *
 * Chosen per script rather than per language: everything that shares a script
 * shares an advance table entry, so one letter per script is enough to cover
 * the whole catalog.
 */
export function typicalCharOf(profile: LocaleProfile): string {
  const language = profile.code.split("-")[0]?.toLowerCase() ?? "";
  switch (language) {
    case "ja":
    case "zh":
      return "定"; // CJK Unified Ideograph — full em square
    case "ko":
      return "한"; // Hangul syllable — also full width
    case "ar":
    case "fa":
    case "ur":
    case "ps":
    case "ckb":
      return "م";
    case "he":
    case "yi":
      return "ש";
    case "el":
      return "α";
    case "ru":
    case "uk":
    case "bg":
    case "sr":
    case "mk":
      return "е"; // Cyrillic ie, not Latin e
    case "th":
      return "ก";
    case "hi":
    case "mr":
    case "ne":
      return "क";
    case "bn":
      return "ক";
    case "ta":
      return "க";
    default:
      return "e";
  }
}
