import { describe, expect, it } from "vitest";
import { getLocaleProfile } from "@/lib/layout";
import { buildDemoJob } from "./demo-data";
import { buildRows } from "./rows";
import { recomputeRow } from "./recompute";
import {
  ALL_FILTER,
  countRows,
  filterRows,
  isFilterActive,
  issueCodeOptions,
  queryTerms,
  type ReviewFilter,
} from "./filtering";

const job = buildDemoJob({ locales: ["de", "ja", "ar"] });
const rows = buildRows(job.catalog, job.results);

const filter = (patch: Partial<ReviewFilter>): ReviewFilter => ({
  ...ALL_FILTER,
  ...patch,
});

describe("queryTerms", () => {
  it("splits on whitespace and lowercases", () => {
    expect(queryTerms("  Save  Button ")).toEqual(["save", "button"]);
  });

  it("keeps a quoted phrase together", () => {
    expect(queryTerms('"end turn" menu')).toEqual(["end turn", "menu"]);
  });

  it("returns nothing for an empty query", () => {
    expect(queryTerms("   ")).toEqual([]);
  });
});

describe("filterRows", () => {
  it("returns everything under the empty filter", () => {
    expect(filterRows(rows, ALL_FILTER)).toHaveLength(rows.length);
  });

  it("filters by locale", () => {
    const out = filterRows(rows, filter({ locale: "ja" }));
    expect(out.length).toBe(job.results[1]?.entries.length);
    expect(out.every((r) => r.locale === "ja")).toBe(true);
  });

  it("filters by status", () => {
    const out = filterRows(rows, filter({ status: "failed" }));
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((r) => r.status === "failed")).toBe(true);
  });

  it("filters by issue code", () => {
    const out = filterRows(rows, filter({ issueCode: "length-tight" }));
    expect(out.length).toBeGreaterThan(0);
    expect(
      out.every((r) => r.issues.some((i) => i.code === "length-tight")),
    ).toBe(true);
  });

  it("searches key, source and target with AND semantics", () => {
    const byKey = filterRows(rows, filter({ query: "hud.floor" }));
    expect(byKey.every((r) => r.key.includes("hud.floor"))).toBe(true);
    expect(byKey.length).toBe(3);

    const bySource = filterRows(rows, filter({ query: "quit desktop" }));
    expect(bySource.length).toBe(3);
    expect(bySource.every((r) => r.source === "Quit to Desktop")).toBe(true);

    expect(filterRows(rows, filter({ query: "hud.floor quit" }))).toHaveLength(0);
  });

  it("is case insensitive", () => {
    expect(filterRows(rows, filter({ query: "DAILY" })).length).toBe(
      filterRows(rows, filter({ query: "daily" })).length,
    );
  });

  it("combines facets", () => {
    const out = filterRows(rows, filter({ locale: "de", status: "failed" }));
    expect(out.every((r) => r.locale === "de" && r.status === "failed")).toBe(
      true,
    );
  });

  it("filters to edited rows only", () => {
    const first = rows[10];
    if (first === undefined) throw new Error("row missing");
    const edited = recomputeRow(first, `${first.target}!`, {
      profile: getLocaleProfile(first.locale),
      sourceLocale: "en",
    });
    const next = rows.map((r) => (r.id === edited.id ? edited : r));
    expect(filterRows(next, filter({ editedOnly: true }))).toHaveLength(1);
  });

  it("returns an empty list rather than throwing when nothing matches", () => {
    expect(filterRows(rows, filter({ query: "zzzz-no-such-string" }))).toEqual(
      [],
    );
  });
});

describe("countRows", () => {
  it("counts every locale when no locale is selected", () => {
    const counts = countRows(rows, ALL_FILTER);
    expect(counts.total).toBe(rows.length);
    expect(counts.visible).toBe(rows.length);
    expect([...counts.byLocale.keys()].sort()).toEqual(["ar", "de", "ja"]);
  });

  it("counts facets as 'what you would see if you clicked this'", () => {
    const active = filter({ status: "failed" });
    const counts = countRows(rows, active);

    // The locale counts ignore nothing except the locale facet itself, so each
    // one is the number of failed rows in that locale.
    for (const [locale, count] of counts.byLocale) {
      expect(count).toBe(
        filterRows(rows, { ...active, locale }).length,
      );
    }

    // The status counts ignore the status facet, so they sum to the whole set.
    const statusTotal = [...counts.byStatus.values()].reduce((a, b) => a + b, 0);
    expect(statusTotal).toBe(rows.length);
  });

  it("keeps facet counts consistent with a locale selection", () => {
    const active = filter({ locale: "de" });
    const counts = countRows(rows, active);
    for (const [status, count] of counts.byStatus) {
      expect(count).toBe(filterRows(rows, { ...active, status }).length);
    }
  });

  it("counts a row once per issue code even with repeated codes", () => {
    const counts = countRows(rows, ALL_FILTER);
    for (const [code, count] of counts.byIssueCode) {
      expect(count).toBe(filterRows(rows, filter({ issueCode: code })).length);
    }
  });

  it("counts overflowing rows within the visible scope", () => {
    const counts = countRows(rows, ALL_FILTER);
    expect(counts.overflow).toBe(
      rows.filter((r) => r.fit?.verdict === "overflow").length,
    );
  });

  it("respects the search box", () => {
    const counts = countRows(rows, filter({ query: "menu." }));
    expect(counts.visible).toBe(filterRows(rows, filter({ query: "menu." })).length);
    expect(counts.visible).toBeLessThan(counts.total);
  });
});

describe("issueCodeOptions", () => {
  it("lists present codes, most frequent first", () => {
    const options = issueCodeOptions(countRows(rows, ALL_FILTER));
    expect(options.length).toBeGreaterThan(0);
    for (let i = 1; i < options.length; i++) {
      expect(options[i - 1]?.count ?? 0).toBeGreaterThanOrEqual(
        options[i]?.count ?? 0,
      );
    }
  });
});

describe("isFilterActive", () => {
  it("is false only for the empty filter", () => {
    expect(isFilterActive(ALL_FILTER)).toBe(false);
    expect(isFilterActive(filter({ query: "  " }))).toBe(false);
    expect(isFilterActive(filter({ locale: "de" }))).toBe(true);
    expect(isFilterActive(filter({ editedOnly: true }))).toBe(true);
    expect(isFilterActive(filter({ query: "save" }))).toBe(true);
  });
});
