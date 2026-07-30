import { describe, expect, it } from "vitest";
import { extractPlaceholders } from "@/lib/core";
import { serializeLocaleResult } from "@/lib/export";
import { getLocaleProfile } from "@/lib/layout";
import { buildDemoJob } from "./demo-data";
import {
  buildRows,
  diffPlaceholders,
  indexCatalog,
  resultWithEdits,
  rowToEntry,
} from "./rows";
import { recomputeRow } from "./recompute";

const job = buildDemoJob({ locales: ["de", "ja"] });
const rows = buildRows(job.catalog, job.results);

const ctx = { profile: getLocaleProfile("de"), sourceLocale: "en" };

describe("buildRows", () => {
  it("produces one row per entry per locale, in result order", () => {
    expect(rows).toHaveLength(
      job.results.reduce((n, r) => n + r.entries.length, 0),
    );
    expect(rows[0]?.locale).toBe("de");
    expect(rows.at(-1)?.locale).toBe("ja");
  });

  it("gives every row a stable, unique id", () => {
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.size).toBe(rows.length);
    expect(rows[0]?.id).toBe(`de::${rows[0]?.key ?? ""}`);
  });

  it("carries the source-side analysis the entry does not have", () => {
    const menuRow = rows.find((r) => r.key === "menu.play");
    expect(menuRow?.role).toBe("menu");
    // The section note is inherited by every key inside it.
    expect(menuRow?.developerNote).toContain("180px");
  });

  it("marks do-not-translate values", () => {
    const url = rows.find((r) => r.key === "meta.supportUrl");
    expect(url?.doNotTranslate).toBe(true);
  });

  it("lists siblings as UI context", () => {
    const row = rows.find((r) => r.key === "menu.play");
    expect(row?.neighbors).toContain("menu.settings");
    expect(row?.neighbors).not.toContain("menu.play");
  });

  it("starts with no edits", () => {
    expect(rows.every((r) => !r.edited)).toBe(true);
    expect(rows.every((r) => r.target === r.modelTarget)).toBe(true);
  });

  it("indexes the catalog by key", () => {
    const index = indexCatalog(job.catalog);
    expect(index.size).toBe(job.catalog.entries.length);
    expect(index.get("hud.floorLabel")?.value).toBe("Floor {n}");
  });
});

describe("diffPlaceholders", () => {
  it("matches identical inventories", () => {
    const source = extractPlaceholders("Floor {n} of {total}");
    const target = extractPlaceholders("Ebene {n} von {total}");
    const diff = diffPlaceholders(source, target);
    expect(diff.matched).toHaveLength(2);
    expect(diff.missing).toHaveLength(0);
    expect(diff.added).toHaveLength(0);
  });

  it("reports a dropped placeholder", () => {
    const diff = diffPlaceholders(
      extractPlaceholders("{count} cards left"),
      extractPlaceholders("Karten übrig"),
    );
    expect(diff.missing.map((p) => p.raw)).toEqual(["{count}"]);
    expect(diff.added).toHaveLength(0);
  });

  it("reports an invented placeholder", () => {
    const diff = diffPlaceholders(
      extractPlaceholders("Level up!"),
      extractPlaceholders("Level {level} erreicht!"),
    );
    expect(diff.added.map((p) => p.raw)).toEqual(["{level}"]);
  });

  it("counts repeats rather than collapsing them", () => {
    const diff = diffPlaceholders(
      extractPlaceholders("{n} of {n}"),
      extractPlaceholders("{n}"),
    );
    expect(diff.matched).toHaveLength(1);
    expect(diff.missing).toHaveLength(1);
  });

  it("ignores order, which the validator reports separately", () => {
    const diff = diffPlaceholders(
      extractPlaceholders("{a} then {b}"),
      extractPlaceholders("{b} dann {a}"),
    );
    expect(diff.missing).toHaveLength(0);
    expect(diff.added).toHaveLength(0);
  });
});

describe("resultWithEdits", () => {
  const deResult = job.results[0];
  if (deResult === undefined) throw new Error("fixture missing");

  it("carries an override into the exported entries", () => {
    const target = rows.find(
      (r) => r.locale === "de" && r.key === "menu.settings",
    );
    if (target === undefined) throw new Error("row missing");

    const edited = recomputeRow(target, "Einstellungen", ctx);
    const next = resultWithEdits(deResult, [edited]);
    const entry = next.entries.find((e) => e.key === "menu.settings");

    expect(entry?.target).toBe("Einstellungen");
    expect(next.entries).toHaveLength(deResult.entries.length);
  });

  it("recomputes stats so the export cannot claim a stale failure count", () => {
    const failing = rows.find((r) => r.locale === "de" && r.status === "failed");
    if (failing === undefined) throw new Error("expected a failed row");

    const fixed = recomputeRow(failing, "Ok", ctx);
    expect(fixed.status).toBe("passed");

    const next = resultWithEdits(deResult, [fixed]);
    expect(next.stats.failed).toBe(deResult.stats.failed - 1);
    expect(next.stats.total).toBe(deResult.stats.total);
  });

  it("keeps rows from other locales out of the result", () => {
    const jaRow = rows.find((r) => r.locale === "ja");
    if (jaRow === undefined) throw new Error("row missing");
    const next = resultWithEdits(deResult, [
      recomputeRow(jaRow, "編集済み", { ...ctx, profile: getLocaleProfile("ja") }),
    ]);
    expect(next.entries).toEqual(deResult.entries);
  });

  it("still serialises to a structurally identical file after edits", () => {
    const target = rows.find(
      (r) => r.locale === "de" && r.key === "menu.settings",
    );
    if (target === undefined) throw new Error("row missing");

    const next = resultWithEdits(deResult, [
      recomputeRow(target, "Einstellungen", ctx),
    ]);
    const file = serializeLocaleResult(job.catalog, next);
    const parsed = JSON.parse(file.contents) as {
      menu: { settings: string };
      meta: { build: number };
    };
    expect(parsed.menu.settings).toBe("Einstellungen");
    expect(parsed.meta.build).toBe(42117);
  });
});

describe("rowToEntry", () => {
  it("round-trips the contract fields", () => {
    const row = rows[3];
    if (row === undefined) throw new Error("row missing");
    const entry = rowToEntry(row);
    expect(entry.key).toBe(row.key);
    expect(entry.locale).toBe(row.locale);
    expect(entry.target).toBe(row.target);
    expect(entry.fit).toBe(row.fit);
  });
});
