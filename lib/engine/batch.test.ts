import { describe, expect, it } from "vitest";

import type { TranslationUnit } from "@/lib/types";
import {
  batchRequests,
  chunkUnits,
  estimateUnitTokens,
  siblingGroupOf,
} from "./batch";
import { makeRequest, makeUnit } from "./testing";

function keysOf(batches: TranslationUnit[][]): string[][] {
  return batches.map((batch) => batch.map((unit) => unit.key));
}

describe("siblingGroupOf", () => {
  it.each([
    ["menu.file.save", "menu.file"],
    ["errors[0].title", "errors[0]"],
    ["errors[0]", "errors"],
    ["title", ""],
    ["", ""],
    ["a.b", "a"],
  ])("%s -> %s", (key, expected) => {
    expect(siblingGroupOf(key)).toBe(expected);
  });

  it("ignores escaped separators", () => {
    expect(siblingGroupOf("group.key\\.with\\.dots")).toBe("group");
  });
});

describe("estimateUnitTokens", () => {
  it("grows with the source and with repair context", () => {
    const small = makeUnit({ key: "a", source: "Save" });
    const large = makeUnit({ key: "a", source: "Save".repeat(60) });
    const repair = makeUnit({
      key: "a",
      source: "Save",
      previousAttempt: "Speichern",
      repairFeedback: "Too long by 4 characters.",
    });

    expect(estimateUnitTokens(large)).toBeGreaterThan(estimateUnitTokens(small));
    expect(estimateUnitTokens(repair)).toBeGreaterThan(estimateUnitTokens(small));
    expect(estimateUnitTokens(small)).toBeGreaterThan(0);
  });
});

describe("chunkUnits", () => {
  it("returns nothing for no units", () => {
    expect(chunkUnits([])).toEqual([]);
  });

  it("keeps everything in one batch when it fits", () => {
    const units = [
      makeUnit({ key: "menu.save", source: "Save" }),
      makeUnit({ key: "menu.open", source: "Open" }),
    ];
    expect(keysOf(chunkUnits(units))).toEqual([["menu.save", "menu.open"]]);
  });

  it("respects the unit ceiling", () => {
    const units = Array.from({ length: 7 }, (_, i) =>
      makeUnit({ key: `g${i}.k`, source: "Save" }),
    );
    const batches = chunkUnits(units, { maxUnits: 3 });
    expect(batches.map((batch) => batch.length)).toEqual([3, 3, 1]);
  });

  it("respects the token ceiling", () => {
    const units = Array.from({ length: 6 }, (_, i) =>
      makeUnit({ key: `g${i}.k`, source: "Some fairly long source string here" }),
    );
    const perUnit = estimateUnitTokens(units[0]!);
    const batches = chunkUnits(units, { maxTokens: perUnit * 2 });
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(2);
    expect(batches.flat()).toHaveLength(6);
  });

  it("never splits a sibling group across batches when the group fits", () => {
    // Three groups of three. A naive size-4 pack would split each group.
    const units = ["menu", "toolbar", "dialog"].flatMap((group) =>
      ["one", "two", "three"].map((leaf) =>
        makeUnit({ key: `${group}.${leaf}`, source: "Save" }),
      ),
    );

    const batches = chunkUnits(units, { maxUnits: 4 });
    for (const batch of batches) {
      const groups = new Set(batch.map((unit) => siblingGroupOf(unit.key)));
      expect(groups.size).toBe(1);
    }
    expect(batches.flat()).toHaveLength(9);
  });

  it("packs several small groups together when they fit", () => {
    const units = ["a", "b", "c"].flatMap((group) => [
      makeUnit({ key: `${group}.one`, source: "Save" }),
      makeUnit({ key: `${group}.two`, source: "Open" }),
    ]);
    expect(chunkUnits(units, { maxUnits: 6 })).toHaveLength(1);
  });

  it("splits a group that cannot fit on its own, keeping siblings adjacent", () => {
    const units = Array.from({ length: 5 }, (_, i) =>
      makeUnit({ key: `big.k${i}`, source: "Save" }),
    );
    const batches = chunkUnits(units, { maxUnits: 2 });
    expect(keysOf(batches)).toEqual([
      ["big.k0", "big.k1"],
      ["big.k2", "big.k3"],
      ["big.k4"],
    ]);
  });

  it("gives an oversized single unit its own batch rather than dropping it", () => {
    const units = [
      makeUnit({ key: "a.one", source: "Save" }),
      makeUnit({ key: "b.huge", source: "x".repeat(20_000), role: "body" }),
      makeUnit({ key: "c.two", source: "Open" }),
    ];
    const batches = chunkUnits(units, { maxTokens: 400 });
    expect(batches.flat()).toHaveLength(3);
    expect(batches.some((batch) => batch.length === 1 && batch[0]?.key === "b.huge")).toBe(
      true,
    );
  });

  it("preserves order and includes every unit exactly once", () => {
    const units = Array.from({ length: 40 }, (_, i) =>
      makeUnit({ key: `g${i % 7}.k${i}`, source: `String number ${i}` }),
    );
    const batches = chunkUnits(units, { maxUnits: 5, maxTokens: 900 });
    const flat = batches.flat();
    expect(flat).toHaveLength(units.length);
    expect(new Set(flat.map((unit) => unit.key)).size).toBe(units.length);
    // Order within a group is preserved even though groups are gathered.
    const groupOrder = flat
      .filter((unit) => unit.key.startsWith("g0."))
      .map((unit) => unit.key);
    expect(groupOrder).toEqual([...groupOrder].sort(byNumericSuffix));
  });

  it("treats root-level keys as one group", () => {
    const units = [
      makeUnit({ key: "save", source: "Save" }),
      makeUnit({ key: "cancel", source: "Cancel" }),
    ];
    expect(chunkUnits(units)).toHaveLength(1);
  });
});

function byNumericSuffix(a: string, b: string): number {
  const na = Number(a.split("k")[1] ?? 0);
  const nb = Number(b.split("k")[1] ?? 0);
  return na - nb;
}

describe("batchRequests", () => {
  it("clones the request per batch, changing only the units", () => {
    const request = makeRequest({
      units: Array.from({ length: 4 }, (_, i) =>
        makeUnit({ key: `g${i}.k`, source: "Save" }),
      ),
    });

    const requests = batchRequests(request, { maxUnits: 2 });
    expect(requests).toHaveLength(2);
    for (const batch of requests) {
      expect(batch.locale).toBe(request.locale);
      expect(batch.tone).toBe(request.tone);
      expect(batch.productContext).toBe(request.productContext);
      expect(batch.glossary).toBe(request.glossary);
    }
    expect(requests.flatMap((batch) => batch.units)).toHaveLength(4);
  });

  it("returns no requests for an empty unit list", () => {
    expect(batchRequests(makeRequest({ units: [] }))).toEqual([]);
  });
});
