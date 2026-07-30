import { describe, expect, it } from "vitest";
import { LOCALE_PROFILES, getLocaleProfile } from "@/lib/layout";
import {
  POPULAR_LOCALES,
  expansionRisk,
  filterLocaleProfiles,
  formatExpansion,
  localeTags,
  matchesLocaleQuery,
  profilesFor,
  selectableLocales,
  worstExpansion,
} from "./locale-search";

const german = getLocaleProfile("de");
const japanese = getLocaleProfile("ja");
const arabic = getLocaleProfile("ar");

describe("selectableLocales", () => {
  it("excludes the source locale", () => {
    const codes = selectableLocales("en").map((p) => p.code);
    expect(codes).not.toContain("en");
    expect(codes).toContain("de");
  });

  it("is sorted by English name", () => {
    const names = selectableLocales("en").map((p) => p.name);
    expect([...names].sort((a, b) => a.localeCompare(b, "en"))).toEqual(names);
  });

  it("matches the catalog size minus the source", () => {
    expect(selectableLocales("en")).toHaveLength(
      Object.keys(LOCALE_PROFILES).length - 1,
    );
  });
});

describe("matchesLocaleQuery", () => {
  it("matches on code, English name and native name", () => {
    expect(matchesLocaleQuery(german, "de")).toBe(true);
    expect(matchesLocaleQuery(german, "german")).toBe(true);
    expect(matchesLocaleQuery(german, "Deutsch")).toBe(true);
  });

  it("ignores diacritics in the query and in the data", () => {
    const french = getLocaleProfile("fr");
    expect(matchesLocaleQuery(french, "francais")).toBe(true);
    expect(matchesLocaleQuery(french, "Français")).toBe(true);
  });

  it("requires every token to match", () => {
    const brazilian = getLocaleProfile("pt-BR");
    expect(matchesLocaleQuery(brazilian, "portuguese brazil")).toBe(true);
    expect(matchesLocaleQuery(brazilian, "portuguese japan")).toBe(false);
  });

  it("treats an empty query as matching everything", () => {
    expect(matchesLocaleQuery(german, "   ")).toBe(true);
  });
});

describe("filterLocaleProfiles", () => {
  it("returns a copy for an empty query", () => {
    const all = selectableLocales("en");
    const filtered = filterLocaleProfiles(all, "");
    expect(filtered).toEqual(all);
    expect(filtered).not.toBe(all);
  });

  it("narrows to the matching profiles", () => {
    const filtered = filterLocaleProfiles(selectableLocales("en"), "portug");
    expect(filtered.length).toBeGreaterThan(0);
    for (const profile of filtered) {
      expect(profile.name.toLowerCase()).toContain("portug");
    }
  });

  it("can return nothing", () => {
    expect(filterLocaleProfiles(selectableLocales("en"), "klingon")).toEqual([]);
  });
});

describe("formatExpansion", () => {
  it("signs growth explicitly", () => {
    expect(formatExpansion(1.35)).toBe("+35% avg");
  });

  it("marks parity", () => {
    expect(formatExpansion(1)).toBe("same length");
  });

  it("uses a real minus sign for shrinkage", () => {
    expect(formatExpansion(0.6)).toBe("−40% avg");
  });
});

describe("expansionRisk", () => {
  it("flags heavy compounding languages", () => {
    expect(expansionRisk(german)).toBe("high");
  });

  it("never calls a full-width script risk-free despite negative expansion", () => {
    // Japanese uses fewer characters but each one is ~an em box, so treating
    // 0.6 as "shorter than English" is exactly the CJK layout trap.
    expect(japanese.expansion).toBeLessThan(1);
    expect(expansionRisk(japanese)).not.toBe("none");
  });

  it("treats the reference locale as no risk", () => {
    expect(expansionRisk(getLocaleProfile("en"))).toBe("none");
  });
});

describe("localeTags", () => {
  it("marks RTL scripts", () => {
    expect(localeTags(arabic)).toContain("RTL");
  });

  it("marks full-width scripts", () => {
    expect(localeTags(japanese)).toContain("wide glyphs");
  });

  it("says nothing about plain Latin locales", () => {
    expect(localeTags(getLocaleProfile("fr"))).toEqual([]);
  });
});

describe("profilesFor / worstExpansion", () => {
  it("resolves in selection order and skips unknown codes", () => {
    expect(profilesFor(["ja", "zzz", "de"]).map((p) => p.code)).toEqual(["ja", "de"]);
  });

  it("returns the widest-expanding selection", () => {
    expect(worstExpansion(["ja", "fr", "de"])?.code).toBe("de");
  });

  it("returns null when nothing is selected", () => {
    expect(worstExpansion([])).toBeNull();
    expect(worstExpansion(["zzz"])).toBeNull();
  });
});

describe("POPULAR_LOCALES", () => {
  it("only names locales that exist in the catalog", () => {
    for (const code of POPULAR_LOCALES) {
      expect(LOCALE_PROFILES[code]).toBeDefined();
    }
  });
});
