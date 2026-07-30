import { describe, expect, it } from "vitest";
import { parseSourceFile } from "@/lib/core";
import { getLocaleProfile } from "@/lib/layout";
import { MAX_NEIGHBORS, neighborKeys, prepareUnits, repairUnit } from "./units";
import type { StringEntry } from "@/lib/types";

const SOURCE = `{
  "menu": {
    "_comment": "Top-level navigation, one horizontal track.",
    "save": "Save",
    "open": "Open",
    "close": "Close"
  },
  "hud": {
    "gold": "{amount} Gold",
    "docs": "https://example.com/docs",
    "level": 7
  }
}
`;

function catalog() {
  return parseSourceFile("en.json", SOURCE);
}

function entry(key: string, value: string): StringEntry {
  return {
    key,
    path: key.split("."),
    value,
    placeholders: [],
    role: "unknown",
    ambiguities: [],
    doNotTranslate: false,
  };
}

describe("neighborKeys", () => {
  it("groups by parent path and excludes the key itself", () => {
    const map = neighborKeys(catalog().entries);
    expect(map.get("menu.save")).toEqual(["menu.open", "menu.close"]);
    expect(map.get("hud.gold")).toEqual(["hud.docs"]);
  });

  it("returns nothing for an only child", () => {
    const map = neighborKeys([entry("a.only", "One")]);
    expect(map.get("a.only")).toEqual([]);
  });

  it("gives each key the siblings it actually sits next to", () => {
    const entries = Array.from({ length: 40 }, (_, i) =>
      entry(`settings.k${String(i).padStart(2, "0")}`, `Value ${i}`),
    );
    const map = neighborKeys(entries);

    const middle = map.get("settings.k20") ?? [];
    expect(middle).toHaveLength(MAX_NEIGHBORS);
    expect(middle).toContain("settings.k19");
    expect(middle).toContain("settings.k21");
    expect(middle).not.toContain("settings.k00");

    // A key at the edge still gets a full window, slid inward.
    const first = map.get("settings.k00") ?? [];
    expect(first).toHaveLength(MAX_NEIGHBORS);
    expect(first[0]).toBe("settings.k01");
  });

  it("never lists a key as its own neighbour", () => {
    const map = neighborKeys(catalog().entries);
    for (const [key, neighbors] of map) {
      expect(neighbors).not.toContain(key);
    }
  });
});

describe("prepareUnits", () => {
  it("splits translatable units from verbatim passthroughs", () => {
    const profile = getLocaleProfile("de");
    const prepared = prepareUnits(catalog().entries, profile);

    expect(prepared.units.map((u) => u.unit.key)).toEqual([
      "menu.save",
      "menu.open",
      "menu.close",
      "hud.gold",
    ]);
    expect(prepared.passthrough.map((e) => e.key)).toEqual(["hud.docs"]);
  });

  it("attaches the layout budget, allowed width and placeholders", () => {
    const profile = getLocaleProfile("de");
    const prepared = prepareUnits(catalog().entries, profile);
    const gold = prepared.units.find((u) => u.unit.key === "hud.gold")?.unit;

    expect(gold?.placeholders.map((p) => p.raw)).toEqual(["{amount}"]);
    expect(gold?.allowedWidth).toBeGreaterThan(0);
    expect(gold?.budget.rationale).toContain("German");
  });

  it("carries the developer note down from a sibling _comment", () => {
    const prepared = prepareUnits(catalog().entries, getLocaleProfile("de"));
    const save = prepared.units.find((u) => u.unit.key === "menu.save")?.unit;
    expect(save?.developerNote).toContain("navigation");
  });

  it("produces per-locale budgets from the same entries", () => {
    const entries = catalog().entries;
    const de = prepareUnits(entries, getLocaleProfile("de"));
    const ja = prepareUnits(entries, getLocaleProfile("ja"));

    // "Save" is short enough that the absolute headroom term dominates for both
    // locales, so the divergence is checked on a longer string.
    const deGold = de.units.find((u) => u.unit.key === "hud.gold")?.unit;
    const jaGold = ja.units.find((u) => u.unit.key === "hud.gold")?.unit;
    expect(deGold?.allowedWidth).not.toBe(jaGold?.allowedWidth);
    expect(deGold?.budget.rationale).toContain("German");
    expect(jaGold?.budget.rationale).toContain("Japanese");
  });

  it("does not alias the parsed catalog across locales", () => {
    const entries = catalog().entries;
    const prepared = prepareUnits(entries, getLocaleProfile("de"));
    const gold = prepared.units.find((u) => u.unit.key === "hud.gold");
    gold?.unit.placeholders.pop();

    const second = prepareUnits(entries, getLocaleProfile("fr"));
    const goldAgain = second.units.find((u) => u.unit.key === "hud.gold")?.unit;
    expect(goldAgain?.placeholders).toHaveLength(1);
  });
});

describe("repairUnit", () => {
  it("adds the feedback fields without mutating the original", () => {
    const prepared = prepareUnits(catalog().entries, getLocaleProfile("de"));
    const original = prepared.units[0]?.unit;
    if (original === undefined) throw new Error("no unit");

    const repaired = repairUnit(original, "Zu lang", "Cut at least 4 characters.");
    expect(repaired.previousAttempt).toBe("Zu lang");
    expect(repaired.repairFeedback).toBe("Cut at least 4 characters.");
    expect(repaired.key).toBe(original.key);
    expect(original.previousAttempt).toBeUndefined();
  });
});
