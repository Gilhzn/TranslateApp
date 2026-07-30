import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractPlaceholders } from "@/lib/core";
import type { JsonValue, LengthBudget, TranslationUnit } from "@/lib/types";
import {
  applyMechanicalFixes,
  assertStructuralParity,
  buildRepairFeedback,
  needsRepair,
  resolveFinalStatus,
  summarizeIssues,
  validateEmittedJson,
  validateTranslation,
} from "./index";

/**
 * Integration: the exact sequence the pipeline runs, over the real fixtures.
 *
 * These tests exist to catch the failure the unit tests structurally cannot —
 * a module that is individually correct but wired into the wrong order.
 */

function fixture(name: string): JsonValue {
  const path = fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as JsonValue;
}

/** Simulate a translator that only ever touches string leaves. */
function mapStrings(value: JsonValue, fn: (s: string) => string): JsonValue {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value !== null && typeof value === "object") {
    const out: { [k: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = mapStrings(child, fn);
    }
    return out;
  }
  return value;
}

const BUDGET: LengthBudget = {
  maxRatio: 1.3,
  maxChars: 18,
  graceRatio: 1.05,
  rationale: "button labels sit in a fixed-width control",
};

function unitFor(key: string, source: string): TranslationUnit {
  return {
    key,
    source,
    role: "button",
    placeholders: extractPlaceholders(source),
    ambiguities: [],
    budget: BUDGET,
    allowedWidth: 5.2,
    neighbors: [],
  };
}

describe("structural guarantee over the shipped fixtures", () => {
  for (const name of ["micro-saas-en.json", "indie-game-en.json"]) {
    it(`${name}: a string-only rewrite preserves structure exactly`, () => {
      const tree = fixture(name);
      const translated = mapStrings(tree, (s) => (s.length > 0 ? `»${s}«` : s));
      expect(assertStructuralParity(tree, translated)).toEqual([]);
    });

    it(`${name}: the serialized output round-trips`, () => {
      const tree = fixture(name);
      const translated = mapStrings(tree, (s) => (s.length > 0 ? `»${s}«` : s));
      const text = `${JSON.stringify(translated, null, 2)}\n`;
      expect(validateEmittedJson(text, tree)).toEqual([]);
    });

    it(`${name}: a dropped key is caught`, () => {
      const tree = fixture(name);
      const translated = mapStrings(tree, (s) => s) as { [k: string]: JsonValue };
      const firstKey = Object.keys(translated)[0];
      expect(firstKey).toBeDefined();
      if (firstKey !== undefined) delete translated[firstKey];
      const issues = assertStructuralParity(tree, translated as JsonValue);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]?.code).toBe("structure-mismatch");
    });
  }
});

describe("the per-entry pipeline", () => {
  const ctx = { key: "actions.delete", role: "button" as const, locale: "de", sourceLocale: "en" };

  it("mechanical fixes alone rescue a cosmetically broken response", () => {
    const source = "Delete {count} items ";
    const raw = '```\n"Lösche \\{count\\} Objekte"\n```';

    expect(needsRepair(validateTranslation(source, raw, null, ctx), null)).toBe(true);

    const fixed = applyMechanicalFixes(source, raw);
    const issues = validateTranslation(source, fixed.text, null, ctx);
    expect(issues).toEqual([]);
    expect(needsRepair(issues, null)).toBe(false);
    expect(resolveFinalStatus(issues, null)).toBe("passed");
  });

  it("a genuinely wrong translation survives the mechanical pass and gets specific feedback", () => {
    const source = "Delete {count} items";
    const raw = "Objekte entfernen";

    const fixed = applyMechanicalFixes(source, raw);
    expect(fixed.changed).toBe(false);

    const issues = validateTranslation(source, fixed.text, null, ctx);
    expect(summarizeIssues(issues).mostSevere).toBe("error");
    expect(needsRepair(issues, null)).toBe(true);

    const feedback = buildRepairFeedback(
      unitFor(ctx.key, source),
      fixed.text,
      issues,
      null,
    );
    expect(feedback).toContain("{count}");
    expect(feedback).toContain("Objekte entfernen");
    expect(resolveFinalStatus(issues, null)).toBe("failed");
  });

  it("warnings alone are delivered flagged, not retried", () => {
    const source = "Hello, ";
    const target = "Hallo,";
    const issues = validateTranslation(source, target, null, ctx);
    expect(summarizeIssues(issues).mostSevere).toBe("warning");
    expect(needsRepair(issues, null)).toBe(false);
    expect(resolveFinalStatus(issues, null)).toBe("flagged");
  });

  it("the mechanical fixer never invents linguistic content", () => {
    const source = "Save";
    const target = "Speichern";
    expect(applyMechanicalFixes(source, target).text).toBe(target);
  });
});
