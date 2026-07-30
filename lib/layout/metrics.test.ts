import { describe, expect, it } from "vitest";
import { getLocaleProfile } from "./locales";
import {
  FULL_WIDTH_ADVANCE,
  averageCharWidth,
  charAdvance,
  estimateLongestLineWidth,
  estimateWidth,
  measureText,
  typicalCharWidth,
} from "./metrics";
import {
  NON_COMBINING_SAMPLE_CHARS,
  SAMPLE_CHARS,
  makeRandom,
  pick,
  randomString,
} from "./testing";

const en = getLocaleProfile("en");
const de = getLocaleProfile("de");
const ja = getLocaleProfile("ja");
const zh = getLocaleProfile("zh-CN");
const ko = getLocaleProfile("ko");
const ar = getLocaleProfile("ar");
const he = getLocaleProfile("he");
const th = getLocaleProfile("th");

function width(text: string): number {
  return estimateWidth(text, en);
}

describe("estimateWidth — Latin advance table", () => {
  it("is not a proxy for character count", () => {
    // Same length, ~2x the width. This is the entire reason the module exists.
    expect("Illicit".length).toBe("Wowwww".length + 1);
    expect(width("Wowwww")).toBeGreaterThan(width("Illicit") * 1.8);
  });

  it("treats i/l/I/j/t/f/r and thin punctuation as narrow", () => {
    for (const char of "ilIjtf.,'!|()[]:;-") {
      expect(charAdvance(char.codePointAt(0) ?? 0, en)).toBeLessThanOrEqual(0.42);
    }
    expect(charAdvance("r".codePointAt(0) ?? 0, en)).toBeLessThanOrEqual(0.42);
  });

  it("treats m/w/M/W/@/% as wide", () => {
    for (const char of "mMW@%") {
      expect(charAdvance(char.codePointAt(0) ?? 0, en)).toBeGreaterThanOrEqual(0.85);
    }
    expect(charAdvance("w".codePointAt(0) ?? 0, en)).toBeGreaterThan(0.7);
  });

  it("renders uppercase wider than lowercase", () => {
    expect(width("SAVE CHANGES")).toBeGreaterThan(width("save changes") * 1.15);
  });

  it("uses tabular digits", () => {
    const widths = [..."0123456789"].map((d) => width(d));
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBeCloseTo(0.55, 2);
  });

  it("gives space a narrow but non-zero advance", () => {
    expect(width(" ")).toBeCloseTo(0.26, 2);
    expect(width("a b")).toBeGreaterThan(width("ab"));
  });
});

describe("estimateWidth — scripts", () => {
  it("gives CJK ideographs, kana and Hangul a full em square", () => {
    for (const char of ["漢", "あ", "カ", "한", "Ａ", "、"]) {
      expect(estimateWidth(char, ja)).toBeGreaterThanOrEqual(FULL_WIDTH_ADVANCE);
    }
    expect(estimateWidth("設定", ja)).toBeCloseTo(2 * ja.glyphWidth, 2);
    expect(estimateWidth("设置", zh)).toBeCloseTo(2 * zh.glyphWidth, 2);
    expect(estimateWidth("설정", ko)).toBeCloseTo(2 * ko.glyphWidth, 2);
  });

  it("measures full-width glyphs honestly even under a Latin profile", () => {
    // A stray ideograph inside a German string is still an em square.
    expect(estimateWidth("漢", de)).toBeGreaterThanOrEqual(FULL_WIDTH_ADVANCE);
  });

  it("makes a short CJK string wider than a longer Latin one", () => {
    // 2 Japanese characters beat 4 English ones — the trap that character
    // counting walks straight into.
    expect(estimateWidth("保存", ja)).toBeGreaterThan(estimateWidth("Save", ja));
  });

  it("keeps half-width katakana half-width", () => {
    expect(estimateWidth("ｱ", ja)).toBeLessThan(FULL_WIDTH_ADVANCE / 2 + 0.1);
  });

  it("runs Arabic and Hebrew about 5% narrower than Latin", () => {
    const latin = charAdvance("n".codePointAt(0) ?? 0, en);
    expect(charAdvance("ع".codePointAt(0) ?? 0, ar)).toBeLessThan(latin);
    expect(charAdvance("א".codePointAt(0) ?? 0, he)).toBeLessThan(latin);
    expect(charAdvance("ع".codePointAt(0) ?? 0, ar)).toBeGreaterThan(latin * 0.85);
  });

  it("gives combining marks, ZWJ and variation selectors zero width", () => {
    for (const cp of [0x0301, 0x064b, 0x05b4, 0x0e34, 0x094d, 0x200d, 0xfe0f, 0xfeff]) {
      expect(charAdvance(cp, en)).toBe(0);
    }
    expect(estimateWidth("e\u0301", en)).toBeCloseTo(estimateWidth("e", en), 5);
  });

  it("gives emoji about 1.2em and flags the same", () => {
    expect(estimateWidth("😀", en)).toBeCloseTo(1.2, 2);
    expect(estimateWidth("🇩🇪", en)).toBeCloseTo(1.2, 2); // two regional indicators
  });

  it("measures Thai base consonants without counting the vowel signs", () => {
    expect(estimateWidth("ก", th)).toBeGreaterThan(0);
    expect(estimateWidth("กิ", th)).toBeCloseTo(estimateWidth("ก", th), 5);
  });

  it("handles Cyrillic and Greek casing", () => {
    const ru = getLocaleProfile("ru");
    expect(charAdvance("Д".codePointAt(0) ?? 0, ru)).toBeGreaterThan(
      charAdvance("д".codePointAt(0) ?? 0, ru),
    );
    const el = getLocaleProfile("el");
    expect(charAdvance("Ω".codePointAt(0) ?? 0, el)).toBeGreaterThan(
      charAdvance("ω".codePointAt(0) ?? 0, el),
    );
  });
});

describe("estimateWidth — monotonicity (property)", () => {
  it("never decreases when a non-combining character is appended", () => {
    const random = makeRandom(0x5eed_1234);
    const profiles = [en, de, ja, ar, th, zh];
    for (let i = 0; i < 3000; i += 1) {
      const profile = pick(random, profiles);
      const base = randomString(random, 12);
      const extra = pick(random, NON_COMBINING_SAMPLE_CHARS);
      const before = estimateWidth(base, profile);
      const after = estimateWidth(base + extra, profile);
      expect(
        after,
        `appending ${JSON.stringify(extra)} to ${JSON.stringify(base)} shrank the width`,
      ).toBeGreaterThanOrEqual(before);
    }
  });

  it("never decreases when any character — combining included — is appended", () => {
    const random = makeRandom(0xc0ffee);
    for (let i = 0; i < 2000; i += 1) {
      const base = randomString(random, 10);
      const extra = pick(random, SAMPLE_CHARS);
      expect(estimateWidth(base + extra, de)).toBeGreaterThanOrEqual(
        estimateWidth(base, de),
      );
    }
  });

  it("is additive across concatenation", () => {
    const random = makeRandom(42);
    for (let i = 0; i < 500; i += 1) {
      const a = randomString(random, 8);
      const b = randomString(random, 8);
      expect(estimateWidth(a + b, de)).toBeCloseTo(
        estimateWidth(a, de) + estimateWidth(b, de),
        2,
      );
    }
  });

  it("is always finite and non-negative", () => {
    const random = makeRandom(7);
    for (let i = 0; i < 1000; i += 1) {
      const text = randomString(random, 20);
      const value = estimateWidth(text, pick(random, [en, ja, ar, th]));
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("measureText — multi-line", () => {
  it("reports the widest line, not the total", () => {
    const measured = measureText("Hi\nA much longer line here", en);
    expect(measured.lineCount).toBe(2);
    expect(measured.longestLineWidth).toBeLessThan(measured.width);
    expect(measured.longestLineWidth).toBeCloseTo(
      estimateWidth("A much longer line here", en),
      3,
    );
  });

  it("treats CRLF, LF, LS and PS all as breaks", () => {
    for (const br of ["\n", "\r\n", "\r", "\u2028", "\u2029"]) {
      expect(measureText(`ab${br}cd`, en).lineCount).toBe(2);
    }
  });

  it("equals the total width for single-line strings", () => {
    expect(estimateLongestLineWidth("Save changes", en)).toBe(
      estimateWidth("Save changes", en),
    );
  });

  it("counts characters and visible characters separately", () => {
    const measured = measureText("e\u0301\u200bx", en);
    expect(measured.charCount).toBe(4);
    expect(measured.visibleCharCount).toBe(2);
  });

  it("handles the empty string", () => {
    const measured = measureText("", en);
    expect(measured.width).toBe(0);
    expect(measured.longestLineWidth).toBe(0);
    expect(measured.lineCount).toBe(1);
    expect(measured.charCount).toBe(0);
  });

  it("counts astral code points once, not as surrogate pairs", () => {
    expect(measureText("😀", en).charCount).toBe(1);
  });
});

describe("averageCharWidth / typicalCharWidth", () => {
  it("reflects the script of the measured text", () => {
    expect(averageCharWidth("保存する", ja)).toBeGreaterThan(1.5);
    expect(averageCharWidth("Speichern", de)).toBeLessThan(0.7);
  });

  it("falls back to the profile's typical width for invisible input", () => {
    expect(averageCharWidth("", de)).toBe(typicalCharWidth(de));
    expect(averageCharWidth("\u200b", de)).toBe(typicalCharWidth(de));
  });

  it("derives typical width from the profile's glyph width", () => {
    expect(typicalCharWidth(en)).toBeCloseTo(0.55, 2);
    expect(typicalCharWidth(ar)).toBeCloseTo(0.52, 2);
    expect(typicalCharWidth(ja)).toBe(ja.glyphWidth);
  });
});
