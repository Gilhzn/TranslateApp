/**
 * End-to-end proof of the whole product.
 *
 * Runs the real pipeline over the repo's real fixtures, through the offline
 * deterministic provider, and asserts the guarantees the product actually
 * sells: structure survives, placeholders survive, nothing overflows, and a
 * failed string never degrades into an empty one.
 *
 * This is deliberately not a unit test — every module is exercised through its
 * public barrel exactly the way the API route drives it.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseSourceFile, serializeWithCatalogFormatting } from "@/lib/core";
import { resolveProvider } from "@/lib/engine";
import { assertStructuralParity, validateEmittedJson } from "@/lib/validate";
import { runJob } from "@/lib/pipeline";
import { getLocaleProfile } from "@/lib/layout";
import type { JobProgress, TranslationSettings } from "@/lib/types";

const FIXTURES = ["indie-game-en.json", "micro-saas-en.json"] as const;

/** Locales chosen to span the hard cases: heavy expansion, CJK, and RTL. */
const TARGETS = ["de", "ja", "ar", "pt-BR"];

function readFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");
}

function settingsFor(targets: string[]): TranslationSettings {
  return {
    sourceLocale: "en",
    targetLocales: targets,
    tone: "gaming",
    productContext: "A roguelike deckbuilder for PC, casual community voice.",
    glossary: [],
    enforceLayout: true,
    maxRepairAttempts: 2,
  };
}

describe.each(FIXTURES)("end-to-end: %s", (fixture) => {
  const raw = readFixture(fixture);
  const catalog = parseSourceFile(fixture, raw);

  it("parses into a non-trivial catalog", () => {
    expect(catalog.entries.length).toBeGreaterThan(20);
    expect(catalog.stats.translatableKeys).toBeGreaterThan(20);
  });

  it("translates every target locale with the guarantees intact", async () => {
    const provider = resolveProvider({ mode: "deterministic" });
    const progress: JobProgress[] = [];

    const job = await runJob({
      catalog,
      settings: settingsFor(TARGETS),
      provider,
      onProgress: (p) => progress.push({ ...p }),
    });

    expect(job.results).toHaveLength(TARGETS.length);

    // Progress must actually advance and terminate, not jump straight to done.
    expect(progress.length).toBeGreaterThan(2);
    expect(progress.at(-1)?.phase).toBe("complete");

    for (const result of job.results) {
      const profile = getLocaleProfile(result.locale);

      // 1. Structure survives — the headline guarantee.
      expect(assertStructuralParity(catalog.tree, result.tree)).toEqual([]);

      // 2. The emitted file is valid JSON that round-trips.
      const text = serializeWithCatalogFormatting(catalog, result.tree);
      expect(validateEmittedJson(text)).toEqual([]);
      expect(() => JSON.parse(text)).not.toThrow();

      // 3. No entry is ever emitted empty for a non-empty source. Shipping
      //    English is acceptable; shipping a blank string is not.
      for (const entry of result.entries) {
        if (entry.source.trim() !== "") {
          expect(
            entry.target,
            `${result.locale} ${entry.key} emitted an empty target`,
          ).not.toBe("");
        }
      }

      // 4. Nothing that shipped as `passed` overflows its bounds.
      const overflowing = result.entries.filter(
        (e) => e.status === "passed" && e.fit?.verdict === "overflow",
      );
      expect(
        overflowing.map((e) => e.key),
        `${result.locale} shipped overflowing strings as passed`,
      ).toEqual([]);

      // 5. Stats are internally consistent.
      const { total, passed, flagged, failed } = result.stats;
      expect(total).toBe(result.entries.length);
      expect(passed + flagged + failed).toBeLessThanOrEqual(total);

      expect(profile.code).toBeTruthy();
    }
  }, 120_000);

  it("preserves every placeholder token in every locale", async () => {
    const provider = resolveProvider({ mode: "deterministic" });
    const job = await runJob({
      catalog,
      settings: settingsFor(["de", "ja"]),
      provider,
    });

    const byKey = new Map(catalog.entries.map((e) => [e.key, e]));

    for (const result of job.results) {
      for (const entry of result.entries) {
        const source = byKey.get(entry.key);
        if (!source || source.placeholders.length === 0) continue;
        if (entry.status === "failed") continue;

        for (const ph of source.placeholders) {
          expect(
            entry.target.includes(ph.raw),
            `${result.locale} ${entry.key}: lost placeholder ${ph.raw} in "${entry.target}"`,
          ).toBe(true);
        }
      }
    }
  }, 120_000);
});
