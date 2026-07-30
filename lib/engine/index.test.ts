/**
 * Engine-level integration: the loop a caller actually runs, plus the
 * structural guarantees the module promises about itself.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractPlaceholders } from "@/lib/core";
import { describeFitForRepair, evaluateFit, getLocaleProfile } from "@/lib/layout";
import type { LocaleCode, TranslationUnit, UiRole } from "@/lib/types";
import {
  chunkUnits,
  describeActiveProvider,
  resolveProvider,
  siblingGroupOf,
} from "./index";
import { makeRequest, makeUnit } from "./testing";

const CATALOG: Array<[string, string, UiRole]> = [
  ["menu.file.save", "Save", "button"],
  ["menu.file.open", "Open", "button"],
  ["menu.file.recent", "Recent files", "menu"],
  ["menu.edit.undo", "Undo", "button"],
  ["menu.edit.redo", "Redo", "button"],
  ["hud.run.start", "Run", "button"],
  ["hud.run.status", "Running…", "label"],
  ["hud.badge.new", "NEW", "badge"],
  ["hud.currency", "{count} Drift Points", "label"],
  ["toast.saved", "Saved {name}", "toast"],
  ["toast.deleted", "Deleted %d items", "toast"],
  ["errors.network.title", "Connection lost", "error"],
  ["errors.network.body", "We couldn't reach the server. Check your connection and try again.", "body"],
  ["settings.audio.label", "Master volume", "label"],
  ["settings.audio.hint", "Applies to music and effects", "tooltip"],
  ["links.docs", "https://example.com/docs", "label"],
  ["theme.accent", "#FF00AA", "label"],
];

function unitsFor(locale: LocaleCode): TranslationUnit[] {
  const profile = getLocaleProfile(locale);
  return CATALOG.map(([key, source, role]) =>
    makeUnit({
      key,
      source,
      role,
      locale: profile,
      neighbors: CATALOG.filter(
        ([sibling]) => sibling !== key && siblingGroupOf(sibling) === siblingGroupOf(key),
      ).map(([sibling]) => sibling),
    }),
  );
}

describe("offline end-to-end", () => {
  const locales: LocaleCode[] = ["de", "fr", "ru", "ja", "ko", "ar", "he", "zh", "fi"];

  for (const locale of locales) {
    it(`translates, validates and repairs a catalog into ${locale}`, async () => {
      const profile = getLocaleProfile(locale);
      const provider = resolveProvider({ env: {}, mode: "deterministic" });
      const units = unitsFor(locale);

      const batches = chunkUnits(units, { maxUnits: 6 });
      expect(batches.flat()).toHaveLength(units.length);

      const results = new Map<string, string>();
      for (const batch of batches) {
        const response = await provider.translate(
          makeRequest({ locale: profile, units: batch, tone: "gaming" }),
        );
        expect(response.issues).toEqual([]);
        expect(response.translations).toHaveLength(batch.length);
        for (const translation of response.translations) {
          results.set(translation.key, translation.target);
        }
      }

      // Every key answered, exactly once.
      expect(results.size).toBe(units.length);

      for (const unit of units) {
        let target = results.get(unit.key);
        expect(target, `no translation for ${unit.key}`).toBeDefined();
        if (target === undefined) continue;

        // Quality bar #3 — placeholders survive exactly.
        for (const placeholder of extractPlaceholders(unit.source)) {
          expect(
            target.includes(placeholder.raw),
            `${unit.key}: lost ${placeholder.raw} in ${JSON.stringify(target)}`,
          ).toBe(true);
        }

        // Quality bar #1 — the repair loop drives everything into its bounds.
        let fit = evaluateFit(unit.source, target, unit.role, profile);
        for (let attempt = 0; attempt < 3 && fit.verdict === "overflow"; attempt += 1) {
          const response = await provider.translate(
            makeRequest({
              locale: profile,
              units: [
                makeUnit({
                  key: unit.key,
                  source: unit.source,
                  role: unit.role,
                  locale: profile,
                  previousAttempt: target,
                  repairFeedback: describeFitForRepair(fit, profile),
                }),
              ],
            }),
          );
          const repaired = response.translations[0]?.target;
          expect(repaired).toBeDefined();
          if (repaired === undefined) break;
          target = repaired;
          fit = evaluateFit(unit.source, target, unit.role, profile);
        }

        expect(
          fit.verdict,
          `${locale} ${unit.key} still overflows: ${JSON.stringify(target)}`,
        ).not.toBe("overflow");
      }
    });
  }

  it("passes machine values through untouched", async () => {
    const provider = resolveProvider({ mode: "deterministic" });
    const units = unitsFor("de").filter((unit) =>
      ["links.docs", "theme.accent"].includes(unit.key),
    );
    const response = await provider.translate(
      makeRequest({ locale: "de", units }),
    );

    for (const translation of response.translations) {
      const unit = units.find((candidate) => candidate.key === translation.key);
      expect(translation.target).toBe(unit?.source);
    }
  });
});

describe("provider honesty", () => {
  it("tells the developer which mode they are in, and the two agree", () => {
    const offline = describeActiveProvider({ env: {} });
    expect(offline.mode).toBe("simulation");
    expect(offline.id).toBe(resolveProvider({ env: {} }).id);

    const live = describeActiveProvider({ env: { ANTHROPIC_API_KEY: "sk-x" } });
    expect(live.mode).toBe("live");
    expect(live.id).toBe(resolveProvider({ env: { ANTHROPIC_API_KEY: "sk-x" } }).id);
  });
});

describe("module hygiene", () => {
  const dir = join(process.cwd(), "lib", "engine");
  const sources = readdirSync(dir).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
  );

  it("has the files the engine is made of", () => {
    expect(sources.length).toBeGreaterThan(4);
  });

  it("never imports the Anthropic SDK statically, so it stays out of the client bundle", () => {
    for (const file of sources) {
      const text = readFileSync(join(dir, file), "utf8");
      const staticImport = /^\s*import[^\n]*from\s*["']@anthropic-ai\/sdk["']/m;
      expect(staticImport.test(text), `${file} statically imports the SDK`).toBe(false);
    }
    // …but it does load it lazily where the live provider needs it.
    const anthropic = readFileSync(join(dir, "anthropic.ts"), "utf8");
    expect(anthropic).toContain('await import("@anthropic-ai/sdk")');
  });

  it("uses no React and no Node-only built-ins, so it runs in the browser too", () => {
    for (const file of sources) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(/from\s*["']react["']/.test(text), `${file} imports React`).toBe(false);
      expect(/from\s*["']node:/.test(text), `${file} imports a node: built-in`).toBe(false);
    }
  });
});
