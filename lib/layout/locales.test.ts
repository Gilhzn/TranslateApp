import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPANSION,
  LOCALE_PROFILES,
  NEUTRAL_LOCALE_PROFILE,
  getLocaleProfile,
  isFullWidthScript,
  isKnownLocale,
  listLocaleProfiles,
  normalizeLocaleCode,
} from "./locales";

const REQUIRED_LOCALES = [
  "de",
  "fr",
  "es",
  "pt-BR",
  "it",
  "nl",
  "pl",
  "ru",
  "tr",
  "ja",
  "ko",
  "zh-CN",
  "zh-TW",
  "ar",
  "he",
  "sv",
  "da",
  "fi",
  "no",
  "cs",
  "uk",
  "id",
  "th",
  "vi",
  "hi",
  "el",
  "ro",
  "hu",
] as const;

describe("LOCALE_PROFILES", () => {
  it("covers every locale the product ships", () => {
    for (const code of REQUIRED_LOCALES) {
      expect(LOCALE_PROFILES[code], `missing profile for ${code}`).toBeDefined();
    }
  });

  it("keys match the profile's own code", () => {
    for (const [key, profile] of Object.entries(LOCALE_PROFILES)) {
      expect(profile.code).toBe(key);
    }
  });

  it("has plausible, non-degenerate values everywhere", () => {
    for (const profile of Object.values(LOCALE_PROFILES)) {
      expect(profile.expansion).toBeGreaterThan(0.4);
      expect(profile.expansion).toBeLessThan(1.6);
      expect(profile.glyphWidth).toBeGreaterThan(0.5);
      expect(profile.glyphWidth).toBeLessThanOrEqual(2.0);
      expect(profile.name.length).toBeGreaterThan(0);
      expect(profile.nativeName.length).toBeGreaterThan(0);
    }
  });

  it("matches published expansion guidance for the major targets", () => {
    expect(LOCALE_PROFILES.de?.expansion).toBeCloseTo(1.35, 2);
    expect(LOCALE_PROFILES.ru?.expansion).toBeCloseTo(1.3, 2);
    expect(LOCALE_PROFILES.pl?.expansion).toBeCloseTo(1.3, 2);
    expect(LOCALE_PROFILES.fi?.expansion).toBeCloseTo(1.3, 2);
    expect(LOCALE_PROFILES.fr?.expansion).toBeCloseTo(1.25, 2);
    expect(LOCALE_PROFILES.es?.expansion).toBeCloseTo(1.25, 2);
    expect(LOCALE_PROFILES["pt-BR"]?.expansion).toBeCloseTo(1.25, 2);
    expect(LOCALE_PROFILES.nl?.expansion).toBeCloseTo(1.25, 2);
    expect(LOCALE_PROFILES.it?.expansion).toBeCloseTo(1.2, 2);
    expect(LOCALE_PROFILES.tr?.expansion).toBeCloseTo(1.15, 2);
    expect(LOCALE_PROFILES.ar?.expansion).toBeCloseTo(1.2, 2);
    expect(LOCALE_PROFILES.he?.expansion).toBeCloseTo(1.2, 2);
  });

  it("gives CJK fewer characters but much wider glyphs", () => {
    for (const code of ["ja", "ko", "zh-CN", "zh-TW"] as const) {
      const profile = LOCALE_PROFILES[code];
      expect(profile).toBeDefined();
      if (profile === undefined) continue;
      expect(profile.expansion).toBeGreaterThanOrEqual(0.55);
      expect(profile.expansion).toBeLessThanOrEqual(0.7);
      expect(profile.glyphWidth).toBeGreaterThanOrEqual(1.85);
      // The combination is what matters: CJK is usually *wider* than English.
      expect(profile.expansion * profile.glyphWidth).toBeGreaterThan(1.0);
      expect(isFullWidthScript(profile)).toBe(true);
    }
  });

  it("marks exactly the RTL languages as rtl", () => {
    const rtl = Object.values(LOCALE_PROFILES)
      .filter((p) => p.direction === "rtl")
      .map((p) => p.code)
      .sort();
    expect(rtl).toEqual(["ar", "fa", "he", "ur"]);
    for (const code of rtl) {
      expect(LOCALE_PROFILES[code]?.glyphWidth).toBeCloseTo(0.95, 2);
    }
  });

  it("marks exactly the space-less scripts as noWordBreaks", () => {
    const noBreaks = Object.values(LOCALE_PROFILES)
      .filter((p) => p.noWordBreaks)
      .map((p) => p.code)
      .sort();
    expect(noBreaks).toEqual([
      "ja",
      "th",
      "zh",
      "zh-CN",
      "zh-HK",
      "zh-TW",
    ]);
    // Korean has inter-word spaces even though it is CJK-width.
    expect(LOCALE_PROFILES.ko?.noWordBreaks).toBe(false);
  });

  it("freezes profiles so no consumer can mutate the catalog", () => {
    const de = LOCALE_PROFILES.de;
    expect(de).toBeDefined();
    expect(Object.isFrozen(de)).toBe(true);
  });
});

describe("normalizeLocaleCode", () => {
  it("normalises case and separators", () => {
    expect(normalizeLocaleCode("PT-br")).toBe("pt-BR");
    expect(normalizeLocaleCode("pt_br")).toBe("pt-BR");
    expect(normalizeLocaleCode("  ZH-hans-cn ")).toBe("zh-Hans-CN");
    expect(normalizeLocaleCode("es-419")).toBe("es-419");
    expect(normalizeLocaleCode("DE")).toBe("de");
  });

  it("returns an empty string for junk", () => {
    expect(normalizeLocaleCode("")).toBe("");
    expect(normalizeLocaleCode("   ")).toBe("");
    expect(normalizeLocaleCode("---")).toBe("");
  });
});

describe("getLocaleProfile", () => {
  it("matches exactly when it can", () => {
    expect(getLocaleProfile("pt-BR").code).toBe("pt-BR");
    expect(getLocaleProfile("zh-TW").code).toBe("zh-TW");
  });

  it("is case and separator insensitive", () => {
    expect(getLocaleProfile("pt_br").code).toBe("pt-BR");
    expect(getLocaleProfile("ZH-tw").code).toBe("zh-TW");
  });

  it("falls back to the base language", () => {
    expect(getLocaleProfile("pt-AO").code).toBe("pt");
    expect(getLocaleProfile("de-AT").code).toBe("de");
    expect(getLocaleProfile("fr-BE").code).toBe("fr");
  });

  it("resolves script subtags via the alias table", () => {
    expect(getLocaleProfile("zh-Hans").code).toBe("zh-CN");
    expect(getLocaleProfile("zh-Hant").code).toBe("zh-TW");
    expect(getLocaleProfile("zh-Hant-HK").code).toBe("zh-HK");
    // Region wins over script when both are present and the region is known.
    expect(getLocaleProfile("zh-Hans-CN").code).toBe("zh-CN");
  });

  it("resolves legacy ISO codes", () => {
    expect(getLocaleProfile("iw").code).toBe("he");
    expect(getLocaleProfile("in").code).toBe("id");
    expect(getLocaleProfile("tl").code).toBe("fil");
  });

  it("falls back to a documented neutral default for unknown locales", () => {
    const profile = getLocaleProfile("xx-YY");
    expect(profile.expansion).toBe(DEFAULT_EXPANSION);
    expect(profile.expansion).toBe(NEUTRAL_LOCALE_PROFILE.expansion);
    expect(profile.direction).toBe("ltr");
    expect(profile.glyphWidth).toBe(1);
    // The requested code is echoed back so the UI can show what was asked for.
    expect(profile.code).toBe("xx-YY");
  });

  it("infers direction for unknown RTL languages", () => {
    const profile = getLocaleProfile("ckb");
    expect(profile.direction).toBe("rtl");
    expect(profile.glyphWidth).toBeCloseTo(0.95, 2);
  });

  it("never throws and never returns a partial profile", () => {
    for (const code of ["", "   ", "!!!", "x", "abcdefghijk", "en-US-POSIX"]) {
      const profile = getLocaleProfile(code);
      expect(typeof profile.expansion).toBe("number");
      expect(Number.isFinite(profile.expansion)).toBe(true);
      expect(typeof profile.glyphWidth).toBe("number");
      expect(["ltr", "rtl"]).toContain(profile.direction);
      expect(typeof profile.noWordBreaks).toBe("boolean");
    }
  });
});

describe("isKnownLocale / listLocaleProfiles", () => {
  it("distinguishes curated from inferred", () => {
    expect(isKnownLocale("de-AT")).toBe(true);
    expect(isKnownLocale("zh-Hans")).toBe(true);
    expect(isKnownLocale("xx")).toBe(false);
    expect(isKnownLocale("")).toBe(false);
  });

  it("lists every profile once, sorted by English name", () => {
    const list = listLocaleProfiles();
    expect(list).toHaveLength(Object.keys(LOCALE_PROFILES).length);
    const names = list.map((p) => p.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")));
  });
});
