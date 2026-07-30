import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "@/lib/core";
import type { Placeholder, StringEntry, UiRole } from "@/lib/types";
import {
  AMBIGUITY_META,
  AMBIGUITY_ORDER,
  ROLE_LABELS,
  ROLE_ORDER,
  catalogHeadlines,
  describeFormatting,
  formatCount,
  groupAmbiguities,
  pickSamples,
  segmentPlaceholders,
  tallyRoles,
  totalAmbiguities,
} from "./catalog-insights";

const FIXTURES = path.resolve(__dirname, "../../fixtures");

function loadFixture(name: string) {
  const raw = readFileSync(path.join(FIXTURES, name), "utf8");
  return parseSourceFile(name, raw);
}

function entry(partial: Partial<StringEntry> & { key: string }): StringEntry {
  return {
    path: partial.key.split("."),
    value: "",
    placeholders: [],
    role: "unknown",
    ambiguities: [],
    doNotTranslate: false,
    ...partial,
  };
}

describe("label tables", () => {
  it("names every UI role exactly once in the display order", () => {
    expect(new Set(ROLE_ORDER).size).toBe(ROLE_ORDER.length);
    for (const role of ROLE_ORDER) {
      expect(ROLE_LABELS[role]).toBeTruthy();
    }
    expect(ROLE_ORDER).toHaveLength(Object.keys(ROLE_LABELS).length);
  });

  it("names every ambiguity kind exactly once", () => {
    expect(new Set(AMBIGUITY_ORDER).size).toBe(AMBIGUITY_ORDER.length);
    expect(AMBIGUITY_ORDER).toHaveLength(Object.keys(AMBIGUITY_META).length);
    for (const kind of AMBIGUITY_ORDER) {
      expect(AMBIGUITY_META[kind].label).toBeTruthy();
      expect(AMBIGUITY_META[kind].blurb.length).toBeGreaterThan(20);
    }
  });
});

describe("tallyRoles", () => {
  it("counts only translatable entries and sums to 1", () => {
    const tallies = tallyRoles([
      entry({ key: "a", role: "button" }),
      entry({ key: "b", role: "button" }),
      entry({ key: "c", role: "body" }),
      entry({ key: "d", role: "body", doNotTranslate: true }),
    ]);

    expect(tallies.map((t) => [t.role, t.count])).toEqual([
      ["button", 2],
      ["body", 1],
    ]);
    expect(tallies.reduce((sum, t) => sum + t.share, 0)).toBeCloseTo(1, 10);
  });

  it("returns nothing when there is nothing translatable", () => {
    expect(tallyRoles([entry({ key: "a", doNotTranslate: true })])).toEqual([]);
  });

  it("follows the fixed role order, not insertion order", () => {
    const tallies = tallyRoles([
      entry({ key: "a", role: "body" }),
      entry({ key: "b", role: "button" }),
    ]);
    expect(tallies[0]?.role).toBe("button");
  });
});

describe("groupAmbiguities", () => {
  const sample: StringEntry[] = [
    entry({
      key: "hud.save",
      value: "Save",
      role: "button",
      ambiguities: [{ kind: "action-or-state", note: "action vs status", confidence: 0.9 }],
    }),
    entry({
      key: "hud.saving",
      value: "Saving…",
      role: "toast",
      ambiguities: [{ kind: "action-or-state", note: "status", confidence: 0.4 }],
    }),
    entry({
      key: "nav.branches",
      value: "Branches",
      role: "menu",
      ambiguities: [{ kind: "tech-term", note: "git term", confidence: 0.8 }],
    }),
    entry({
      key: "skip.me",
      value: "https://example.com",
      doNotTranslate: true,
      ambiguities: [{ kind: "brand-term", note: "url", confidence: 1 }],
    }),
  ];

  it("groups by kind and orders by severity of the kind", () => {
    const groups = groupAmbiguities(sample);
    expect(groups.map((g) => g.kind)).toEqual(["action-or-state", "tech-term"]);
  });

  it("ignores do-not-translate entries", () => {
    expect(groupAmbiguities(sample).some((g) => g.kind === "brand-term")).toBe(false);
  });

  it("sorts items by confidence", () => {
    const [group] = groupAmbiguities(sample);
    expect(group?.items.map((i) => i.key)).toEqual(["hud.save", "hud.saving"]);
  });

  it("caps the rendered items and reports the overflow", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      entry({
        key: `k${i}`,
        value: "Run",
        ambiguities: [{ kind: "verb-or-noun", note: "verb or noun", confidence: 0.5 }],
      }),
    );
    const [group] = groupAmbiguities(many, { perGroup: 3 });
    expect(group?.count).toBe(9);
    expect(group?.items).toHaveLength(3);
    expect(group?.overflow).toBe(6);
  });

  it("totals across groups", () => {
    expect(totalAmbiguities(groupAmbiguities(sample))).toBe(3);
  });
});

describe("pickSamples", () => {
  it("prefers one entry per distinct role before filling by length", () => {
    const entries: StringEntry[] = [
      entry({ key: "b1", role: "button", value: "Go" }),
      entry({ key: "b2", role: "button", value: "Also go" }),
      entry({ key: "t1", role: "body", value: "A long-ish body string" }),
    ];
    const picked = pickSamples(entries, 2);
    expect(picked.map((e) => e.role)).toEqual(["button", "body"]);
  });

  it("fills the remainder with the longest strings", () => {
    const entries: StringEntry[] = [
      entry({ key: "b1", role: "button", value: "Go" }),
      entry({ key: "b2", role: "button", value: "Short" }),
      entry({ key: "b3", role: "button", value: "The very longest one here" }),
    ];
    expect(pickSamples(entries, 2).map((e) => e.key)).toEqual(["b1", "b3"]);
  });

  it("never returns do-not-translate entries, and handles empty input", () => {
    expect(pickSamples([entry({ key: "a", doNotTranslate: true })], 3)).toEqual([]);
    expect(pickSamples([], 3)).toEqual([]);
    expect(pickSamples([entry({ key: "a" })], 0)).toEqual([]);
  });
});

describe("segmentPlaceholders", () => {
  function placeholder(raw: string, index: number): Placeholder {
    return { raw, kind: "icu", token: raw.slice(1, -1), index };
  }

  it("splits literal and placeholder runs", () => {
    const segments = segmentPlaceholders("Floor {n} of {max}", [
      placeholder("{n}", 6),
      placeholder("{max}", 13),
    ]);
    expect(segments).toEqual([
      { text: "Floor ", placeholder: false },
      { text: "{n}", placeholder: true },
      { text: " of ", placeholder: false },
      { text: "{max}", placeholder: true },
    ]);
  });

  it("reassembles to exactly the source string", () => {
    const value = "{count} cards left";
    const segments = segmentPlaceholders(value, [placeholder("{count}", 0)]);
    expect(segments.map((s) => s.text).join("")).toBe(value);
  });

  it("drops overlapping (nested ICU) matches instead of duplicating text", () => {
    const value = "{count, plural, one {# card} other {# cards}}";
    const segments = segmentPlaceholders(value, [
      { raw: value, kind: "icu", token: "count", index: 0 },
      { raw: "{# card}", kind: "icu", token: "#", index: 20 },
    ]);
    expect(segments.map((s) => s.text).join("")).toBe(value);
    expect(segments.filter((s) => s.placeholder)).toHaveLength(1);
  });

  it("ignores an index that no longer matches the text", () => {
    const segments = segmentPlaceholders("Hello", [placeholder("{n}", 2)]);
    expect(segments).toEqual([{ text: "Hello", placeholder: false }]);
  });

  it("returns nothing for an empty string", () => {
    expect(segmentPlaceholders("", [])).toEqual([]);
  });
});

describe("formatCount", () => {
  it("groups thousands", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatCount(0)).toBe("0");
  });
});

describe("against the real fixtures", () => {
  const cases: readonly string[] = ["indie-game-en.json", "micro-saas-en.json"];

  for (const name of cases) {
    it(`derives a consistent summary for ${name}`, () => {
      const catalog = loadFixture(name);

      const headlines = catalogHeadlines(catalog);
      expect(headlines).toHaveLength(6);
      expect(headlines.map((h) => h.label)).toContain("Translatable");

      const tallies = tallyRoles(catalog.entries);
      const counted = tallies.reduce((sum, t) => sum + t.count, 0);
      expect(counted).toBe(catalog.stats.translatableKeys);

      // Every role that shows up must have a label.
      for (const tally of tallies) {
        expect(ROLE_LABELS[tally.role as UiRole]).toBeTruthy();
      }

      const samples = pickSamples(catalog.entries, 5);
      expect(samples).toHaveLength(5);
      for (const sample of samples) {
        expect(sample.doNotTranslate).toBe(false);
        expect(segmentPlaceholders(sample.value, sample.placeholders)
          .map((s) => s.text)
          .join("")).toBe(sample.value);
      }

      expect(describeFormatting(catalog)).toContain("2-space indent");
    });
  }

  it("finds ambiguities worth showing in the indie-game catalog", () => {
    const catalog = loadFixture("indie-game-en.json");
    const groups = groupAmbiguities(catalog.entries);
    expect(groups.length).toBeGreaterThan(0);
    expect(totalAmbiguities(groups)).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.items.length).toBeGreaterThan(0);
      expect(group.items.length).toBeLessThanOrEqual(4);
      for (const item of group.items) {
        expect(item.note.length).toBeGreaterThan(0);
      }
    }
  });
});
