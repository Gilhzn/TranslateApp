import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSourceFile, serializeWithCatalogFormatting } from "@/lib/core";
import { DeterministicProvider } from "@/lib/engine";
import { assertStructuralParity, validateEmittedJson } from "@/lib/validate";
import type {
  JobProgress,
  JsonValue,
  LocaleResult,
  TranslatedEntry,
} from "@/lib/types";
import { JobAbortedError, StructuralIntegrityError } from "./errors";
import { ProgressTracker } from "./progress";
import { runJob, runLocale } from "./run";
import { ScriptedProvider, settings } from "./testing";

const FIXTURES = path.resolve(__dirname, "../../fixtures");

function fixture(name: string) {
  return parseSourceFile(name, readFileSync(path.join(FIXTURES, name), "utf8"));
}

const SMALL = `{
  "menu": {
    "save": "Save",
    "cancel": "Cancel"
  },
  "hud": {
    "gold": "{amount} Gold",
    "version": "1.4.2"
  }
}
`;

function smallCatalog() {
  return parseSourceFile("en.json", SMALL);
}

/**
 * A clean German answer for every translatable key in {@link SMALL}. Tests
 * override single keys on top of this so the unit under test is the only thing
 * that can trigger a repair.
 */
const GERMAN: Readonly<Record<string, string>> = {
  "menu.save": "Sichern",
  "menu.cancel": "Abbrechen",
  "hud.gold": "{amount} Münzen",
};

function german(key: string): string {
  return GERMAN[key] ?? "Übersetzt";
}

function entryFor(result: LocaleResult, key: string): TranslatedEntry {
  const found = result.entries.find((entry) => entry.key === key);
  if (found === undefined) throw new Error(`no entry for ${key}`);
  return found;
}

function valueAt(tree: JsonValue, segments: readonly string[]): JsonValue {
  let node: JsonValue = tree;
  for (const segment of segments) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      throw new Error(`cannot descend into ${segment}`);
    }
    const next = node[segment];
    if (next === undefined) throw new Error(`missing ${segment}`);
    node = next;
  }
  return node;
}

describe("runLocale — structural integrity", () => {
  it("emits a tree structurally identical to the source, on both fixtures", async () => {
    for (const name of ["indie-game-en.json", "micro-saas-en.json"]) {
      const catalog = fixture(name);
      const result = await runLocale({
        catalog,
        settings: settings({ targetLocales: ["de"] }),
        locale: "de",
        provider: new DeterministicProvider({ seed: "test" }),
      });

      expect(assertStructuralParity(catalog.tree, result.tree)).toEqual([]);

      const text = serializeWithCatalogFormatting(catalog, result.tree);
      expect(validateEmittedJson(text, catalog.tree)).toEqual([]);
    }
  });

  it("throws a hard job-level error when the rebuilt tree diverges", async () => {
    const catalog = smallCatalog();

    await expect(
      runLocale({
        catalog,
        settings: settings(),
        locale: "de",
        provider: new DeterministicProvider({ seed: "test" }),
        // Fault injection: a rebuilder that drops a key. Production always uses
        // `rebuildTree`; this proves the parity gate would catch a regression
        // there rather than shipping a corrupt catalogue.
        rebuild: (template) => {
          const clone = JSON.parse(JSON.stringify(template)) as Record<string, JsonValue>;
          const menu = clone["menu"];
          if (menu !== null && typeof menu === "object" && !Array.isArray(menu)) {
            delete menu["cancel"];
          }
          return clone;
        },
      }),
    ).rejects.toBeInstanceOf(StructuralIntegrityError);
  });

  it("names the diverging paths on the structural error", async () => {
    const catalog = smallCatalog();
    let caught: unknown = null;
    try {
      await runLocale({
        catalog,
        settings: settings(),
        locale: "de",
        provider: new DeterministicProvider({ seed: "test" }),
        rebuild: () => ({ totally: "different" }),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StructuralIntegrityError);
    const structural = caught as StructuralIntegrityError;
    expect(structural.locale).toBe("de");
    expect(structural.issues.length).toBeGreaterThan(0);
    expect(structural.issues.every((i) => i.code === "structure-mismatch")).toBe(true);
  });
});

describe("runLocale — the repair loop", () => {
  it("converges: an overflowing first attempt is repaired and passes", async () => {
    const catalog = smallCatalog();
    const provider = new ScriptedProvider((unit, { attempt }) => {
      if (unit.key !== "menu.save") return german(unit.key);
      return attempt === 1
        ? "Diesen Spielstand jetzt dauerhaft sichern"
        : "Sichern";
    });

    const result = await runLocale({
      catalog,
      settings: settings({ maxRepairAttempts: 2 }),
      locale: "de",
      provider,
    });

    const save = entryFor(result, "menu.save");
    expect(save.attempts).toBe(2);
    expect(save.target).toBe("Sichern");
    expect(save.status).toBe("passed");
    expect(save.fit?.verdict).toBe("fits");
    expect(result.stats.overflowRepaired).toBe(1);

    // The repair pass re-issued ONLY the failing unit.
    const repairCalls = provider.calls.filter((call) => call.repair);
    expect(repairCalls).toHaveLength(1);
    expect(repairCalls[0]?.keys).toEqual(["menu.save"]);
  });

  it("carries previousAttempt and repairFeedback on every repair unit", async () => {
    const catalog = smallCatalog();
    const seen: Array<{ previous: string | undefined; feedback: string | undefined }> = [];

    const provider = new ScriptedProvider(
      (unit, { attempt }) => {
        if (unit.key !== "menu.save") return german(unit.key);
        return attempt === 1 ? "Ein viel zu langer Knopftext hier" : "Sichern";
      },
      {
        onBatch: (request) => {
          for (const unit of request.units) {
            if (unit.repairFeedback === undefined) continue;
            seen.push({
              previous: unit.previousAttempt,
              feedback: unit.repairFeedback,
            });
          }
        },
      },
    );

    await runLocale({
      catalog,
      settings: settings({ maxRepairAttempts: 2 }),
      locale: "de",
      provider,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.previous).toBe("Ein viel zu langer Knopftext hier");
    expect(seen[0]?.feedback).toContain("menu.save");
    expect(seen[0]?.feedback).toContain("Cut at least");
  });

  it("stops at maxRepairAttempts and records budget-exhausted", async () => {
    const catalog = smallCatalog();
    const provider = new ScriptedProvider((unit) =>
      unit.key === "menu.save"
        ? "Diesen Spielstand jetzt dauerhaft sichern"
        : german(unit.key),
    );

    const result = await runLocale({
      catalog,
      settings: settings({ maxRepairAttempts: 1 }),
      locale: "de",
      provider,
    });

    const save = entryFor(result, "menu.save");
    expect(save.attempts).toBe(2); // first pass + one repair
    expect(save.status).toBe("failed");
    expect(save.issues.some((i) => i.code === "budget-exhausted")).toBe(true);
  });

  it("does not spend a repair call when the first pass is clean", async () => {
    const catalog = smallCatalog();
    const provider = new ScriptedProvider((unit) => german(unit.key));

    await runLocale({
      catalog,
      settings: settings({ maxRepairAttempts: 3 }),
      locale: "de",
      provider,
    });

    expect(provider.calls.filter((call) => call.repair)).toHaveLength(0);
  });

  it("honours maxRepairAttempts: 0 by never re-issuing", async () => {
    const catalog = smallCatalog();
    const provider = new ScriptedProvider((unit) =>
      unit.key === "menu.save"
        ? "Diesen Spielstand jetzt dauerhaft sichern"
        : german(unit.key),
    );

    const result = await runLocale({
      catalog,
      settings: settings({ maxRepairAttempts: 0 }),
      locale: "de",
      provider,
    });

    expect(provider.calls.filter((call) => call.repair)).toHaveLength(0);
    expect(entryFor(result, "menu.save").attempts).toBe(1);
  });
});

describe("runLocale — a failed entry never corrupts the output", () => {
  it("keeps the source value in the tree for an entry that failed", async () => {
    const catalog = smallCatalog();
    const provider = new ScriptedProvider((unit) =>
      unit.key === "menu.save"
        ? "Diesen Spielstand jetzt dauerhaft sichern"
        : german(unit.key),
    );

    const result = await runLocale({
      catalog,
      settings: settings({ maxRepairAttempts: 0 }),
      locale: "de",
      provider,
    });

    expect(entryFor(result, "menu.save").status).toBe("failed");
    // The rejected attempt is kept on the entry for review, but the emitted
    // tree keeps English: an overflowing button is a production defect.
    expect(valueAt(result.tree, ["menu", "save"])).toBe("Save");
    expect(valueAt(result.tree, ["menu", "cancel"])).toBe("Abbrechen");
  });

  it("never emits an empty string for a non-empty source", async () => {
    const catalog = smallCatalog();
    const provider = new ScriptedProvider((unit) =>
      unit.key === "menu.save" ? "" : german(unit.key),
    );

    const result = await runLocale({
      catalog,
      settings: settings({ maxRepairAttempts: 0 }),
      locale: "de",
      provider,
    });

    const save = entryFor(result, "menu.save");
    expect(save.status).toBe("failed");
    expect(save.issues.some((i) => i.code === "empty-translation")).toBe(true);
    expect(save.target).toBe("Save");
    expect(valueAt(result.tree, ["menu", "save"])).toBe("Save");
  });

  it("keeps the source when a placeholder was dropped", async () => {
    const catalog = smallCatalog();
    const provider = new ScriptedProvider((unit) =>
      unit.key === "hud.gold" ? "Münzen" : german(unit.key),
    );

    const result = await runLocale({
      catalog,
      settings: settings({ maxRepairAttempts: 0 }),
      locale: "de",
      provider,
    });

    const gold = entryFor(result, "hud.gold");
    expect(gold.status).toBe("failed");
    expect(gold.issues.some((i) => i.code === "placeholder-missing")).toBe(true);
    expect(valueAt(result.tree, ["hud", "gold"])).toBe("{amount} Gold");
  });

  it("fails the entry when the provider drops its key entirely", async () => {
    const catalog = smallCatalog();
    const provider = new ScriptedProvider((unit) =>
      unit.key === "menu.save" ? null : german(unit.key),
    );

    const result = await runLocale({
      catalog,
      settings: settings({ maxRepairAttempts: 2 }),
      locale: "de",
      provider,
    });

    const save = entryFor(result, "menu.save");
    expect(save.status).toBe("failed");
    expect(save.target).toBe("Save");
    expect(save.issues.some((i) => i.code === "provider-error")).toBe(true);
    expect(valueAt(result.tree, ["menu", "save"])).toBe("Save");
    // No repair is attempted: there is no attempt to give feedback about.
    expect(provider.calls.filter((call) => call.repair)).toHaveLength(0);
  });

  it("survives a provider that fails the whole batch", async () => {
    const catalog = smallCatalog();
    const provider = new ScriptedProvider(() => null, {
      issues: [
        {
          code: "provider-error",
          severity: "error",
          message: "ANTHROPIC_API_KEY is not set.",
        },
      ],
    });

    const result = await runLocale({
      catalog,
      settings: settings(),
      locale: "de",
      provider,
    });

    expect(result.stats.failed).toBe(3);
    expect(result.stats.passed).toBe(1); // the do-not-translate version string
    expect(result.issues.some((i) => i.message.includes("ANTHROPIC_API_KEY"))).toBe(true);
    expect(assertStructuralParity(catalog.tree, result.tree)).toEqual([]);
    expect(valueAt(result.tree, ["menu", "save"])).toBe("Save");
  });
});

describe("runLocale — passthrough and statistics", () => {
  it("passes do-not-translate values through verbatim with no model call", async () => {
    const catalog = smallCatalog();
    const provider = new ScriptedProvider((unit) => german(unit.key));

    const result = await runLocale({
      catalog,
      settings: settings(),
      locale: "de",
      provider,
    });

    const version = entryFor(result, "hud.version");
    expect(version.status).toBe("passed");
    expect(version.attempts).toBe(0);
    expect(version.target).toBe("1.4.2");
    for (const call of provider.calls) {
      expect(call.keys).not.toContain("hud.version");
    }
  });

  it("reports stats that add up", async () => {
    const catalog = fixture("micro-saas-en.json");
    const result = await runLocale({
      catalog,
      settings: settings(),
      locale: "fr",
      provider: new DeterministicProvider({ seed: "stats" }),
    });

    const { total, passed, flagged, failed } = result.stats;
    expect(total).toBe(catalog.entries.length);
    expect(passed + flagged + failed).toBe(total);
    expect(result.entries).toHaveLength(total);
    expect(result.stats.averageRatio).toBeGreaterThan(0);
  });

  it("reports the fit but does not enforce it when enforceLayout is off", async () => {
    const catalog = smallCatalog();
    const provider = new ScriptedProvider((unit) =>
      unit.key === "menu.save"
        ? "Diesen Spielstand jetzt dauerhaft sichern"
        : german(unit.key),
    );

    const result = await runLocale({
      catalog,
      settings: settings({ enforceLayout: false, maxRepairAttempts: 2 }),
      locale: "de",
      provider,
    });

    const save = entryFor(result, "menu.save");
    expect(save.fit?.verdict).toBe("overflow"); // still measured, still shown
    expect(save.status).not.toBe("failed"); // but not enforced
    expect(provider.calls.filter((call) => call.repair)).toHaveLength(0);
    expect(valueAt(result.tree, ["menu", "save"])).toBe(
      "Diesen Spielstand jetzt dauerhaft sichern",
    );
  });
});

describe("runLocale — units", () => {
  it("hands the model role, budget, placeholders and sibling context", async () => {
    const catalog = smallCatalog();
    let captured: ReturnType<typeof Object> | null = null;
    const provider = new ScriptedProvider((unit) => german(unit.key), {
      onBatch: (request) => {
        for (const unit of request.units) {
          if (unit.key === "hud.gold") captured = unit;
        }
      },
    });

    await runLocale({
      catalog,
      settings: settings(),
      locale: "de",
      provider,
    });

    expect(captured).not.toBeNull();
    const unit = captured as unknown as {
      role: string;
      placeholders: Array<{ raw: string }>;
      allowedWidth: number;
      neighbors: string[];
      budget: { rationale: string };
    };
    expect(unit.placeholders.map((p) => p.raw)).toEqual(["{amount}"]);
    expect(unit.allowedWidth).toBeGreaterThan(0);
    expect(unit.budget.rationale.length).toBeGreaterThan(0);
    // Its sibling in the same object, and nothing from another branch.
    expect(unit.neighbors).toContain("hud.version");
    expect(unit.neighbors).not.toContain("menu.save");
  });
});

describe("runLocale — cancellation", () => {
  it("stops issuing provider calls once the signal fires", async () => {
    const catalog = fixture("indie-game-en.json");
    const controller = new AbortController();
    let batches = 0;

    const provider = new ScriptedProvider((unit) => german(unit.key), {
      onBatch: () => {
        batches += 1;
        if (batches === 1) controller.abort();
      },
    });

    await expect(
      runLocale({
        catalog,
        settings: settings(),
        locale: "de",
        provider,
        signal: controller.signal,
        batchConcurrency: 2,
        batch: { maxUnits: 5, maxTokens: 400 },
      }),
    ).rejects.toBeInstanceOf(JobAbortedError);

    // The already-dispatched batches finish; nothing new is bought.
    expect(batches).toBeLessThanOrEqual(3);
  });

  it("refuses to start when the signal has already fired", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new ScriptedProvider((unit) => german(unit.key));

    await expect(
      runLocale({
        catalog: smallCatalog(),
        settings: settings(),
        locale: "de",
        provider,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(JobAbortedError);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("runJob", () => {
  it("translates every locale and reports monotonic, exact progress", async () => {
    const catalog = fixture("micro-saas-en.json");
    const frames: JobProgress[] = [];
    const completedLocales: string[] = [];

    const job = await runJob({
      catalog,
      settings: settings({ targetLocales: ["de", "fr", "ja"] }),
      provider: new DeterministicProvider({ seed: "job" }),
      onProgress: (progress) => frames.push(progress),
      onLocaleComplete: (result) => completedLocales.push(result.locale),
    });

    expect(job.results.map((r) => r.locale)).toEqual(["de", "fr", "ja"]);
    expect(completedLocales.sort()).toEqual(["de", "fr", "ja"]);
    expect(job.finishedAt).not.toBeNull();

    const expectedTotal = catalog.entries.length * 3;
    expect(frames[0]?.phase).toBe("queued");
    expect(frames.at(-1)?.phase).toBe("complete");
    expect(frames.at(-1)?.completedUnits).toBe(expectedTotal);
    expect(frames.at(-1)?.progress).toBe(1);

    let previous = 0;
    for (const frame of frames) {
      expect(frame.completedUnits).toBeGreaterThanOrEqual(previous);
      expect(frame.totalUnits).toBe(expectedTotal);
      expect(frame.message.length).toBeGreaterThan(0);
      previous = frame.completedUnits;
    }

    const phases = new Set(frames.map((frame) => frame.phase));
    expect(phases.has("analyzing")).toBe(true);
    expect(phases.has("translating")).toBe(true);
    expect(phases.has("validating")).toBe(true);
  });

  it("runs locales concurrently under the configured bound", async () => {
    const catalog = smallCatalog();
    let inFlight = 0;
    let peak = 0;

    const provider = new ScriptedProvider((unit) => german(unit.key), {
      onBatch: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      },
    });

    await runJob({
      catalog,
      settings: settings({ targetLocales: ["de", "fr", "es", "it", "ja"] }),
      provider,
      localeConcurrency: 2,
    });

    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });

  it("de-duplicates target locales", async () => {
    const job = await runJob({
      catalog: smallCatalog(),
      settings: settings({ targetLocales: ["de", "de", "fr"] }),
      provider: new DeterministicProvider({ seed: "dedupe" }),
    });
    expect(job.results.map((r) => r.locale)).toEqual(["de", "fr"]);
  });

  it("reports an error phase and rethrows when a locale fails structurally", async () => {
    const frames: JobProgress[] = [];
    await expect(
      runJob({
        catalog: smallCatalog(),
        settings: settings({ targetLocales: ["de"] }),
        provider: new DeterministicProvider({ seed: "x" }),
        onProgress: (progress) => frames.push(progress),
        rebuild: () => ({ nope: true }),
      }),
    ).rejects.toBeInstanceOf(StructuralIntegrityError);
    expect(frames.at(-1)?.phase).toBe("error");
  });

  it("propagates cancellation to every locale", async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider((unit) => german(unit.key), {
      onBatch: () => {
        controller.abort();
      },
    });

    const frames: JobProgress[] = [];
    await expect(
      runJob({
        catalog: fixture("indie-game-en.json"),
        settings: settings({ targetLocales: ["de", "fr", "ja"] }),
        provider,
        signal: controller.signal,
        onProgress: (progress) => frames.push(progress),
      }),
    ).rejects.toBeInstanceOf(JobAbortedError);
    expect(frames.at(-1)?.phase).toBe("error");
  });

  it("accepts an externally supplied progress tracker for a single locale", async () => {
    const catalog = smallCatalog();
    const frames: JobProgress[] = [];
    const tracker = new ProgressTracker(catalog.entries.length, (p) => frames.push(p));

    await runLocale({
      catalog,
      settings: settings(),
      locale: "de",
      provider: new DeterministicProvider({ seed: "t" }),
      progress: tracker,
    });

    expect(tracker.completedUnits).toBe(catalog.entries.length);
    expect(frames.length).toBeGreaterThan(0);
  });
});
