import { describe, expect, it } from "vitest";
import { getLocaleProfile } from "@/lib/layout";
import { buildDemoJob } from "./demo-data";
import { buildRows, type ReviewRow } from "./rows";
import {
  budgetRationaleForRow,
  evaluateTarget,
  recomputeRow,
  repairFeedbackForRow,
  revertRow,
  tidyRow,
  trimRowToFit,
  unitForRow,
  type RecomputeContext,
} from "./recompute";

const job = buildDemoJob({ locales: ["de"] });
const rows = buildRows(job.catalog, job.results);
const ctx: RecomputeContext = {
  profile: getLocaleProfile("de"),
  sourceLocale: "en",
  glossary: job.settings.glossary,
};

function rowFor(key: string): ReviewRow {
  const row = rows.find((r) => r.key === key);
  if (row === undefined) throw new Error(`no row for ${key}`);
  return row;
}

describe("recomputeRow — the overflow guarantee", () => {
  const button = rowFor("actions.endTurn");

  it("flags an edit that overflows the instant it does", () => {
    const edited = recomputeRow(
      button,
      "Diesen kompletten Spielzug jetzt endgültig beenden",
      ctx,
    );
    expect(edited.fit?.verdict).toBe("overflow");
    expect(edited.status).toBe("failed");
    expect(edited.issues.some((i) => i.code === "length-overflow")).toBe(true);
  });

  it("clears the flag the moment the edit fits again", () => {
    const overflowing = recomputeRow(button, "Zug jetzt endgültig beenden", ctx);
    const fixed = recomputeRow(overflowing, "Zug Ende", ctx);
    expect(fixed.fit?.verdict).not.toBe("overflow");
    expect(fixed.issues.some((i) => i.code === "length-overflow")).toBe(false);
  });

  it("reports the grace band distinctly from a clean fit", () => {
    const source = rowFor("menu.settings");
    const verdicts = new Set<string>();
    for (const candidate of ["Optionen", "Einstellungen", "Systemeinstellungen"]) {
      const evaluated = evaluateTarget(source, candidate, ctx);
      verdicts.add(evaluated.fit.verdict);
    }
    expect(verdicts.size).toBeGreaterThan(1);
  });

  it("marks a row as edited only while it differs from the model output", () => {
    const edited = recomputeRow(button, "Zug Ende", ctx);
    expect(edited.edited).toBe(true);
    expect(recomputeRow(edited, button.modelTarget, ctx).edited).toBe(false);
  });

  it("re-runs the placeholder validators, not just the layout check", () => {
    const withPlaceholder = rowFor("hud.floorLabel");
    const broken = recomputeRow(withPlaceholder, "Ebene", ctx);
    expect(broken.issues.some((i) => i.code === "placeholder-missing")).toBe(true);
    expect(broken.status).toBe("failed");

    const fixed = recomputeRow(broken, "Ebene {n}", ctx);
    expect(fixed.issues.some((i) => i.code === "placeholder-missing")).toBe(false);
  });

  it("catches an invented placeholder too", () => {
    const row = rowFor("menu.play");
    const broken = recomputeRow(row, "{go}", ctx);
    expect(broken.issues.some((i) => i.code === "placeholder-added")).toBe(true);
  });

  it("flags a blanked translation rather than accepting it", () => {
    const broken = recomputeRow(rowFor("menu.play"), "", ctx);
    expect(broken.issues.some((i) => i.code === "empty-translation")).toBe(true);
    expect(broken.status).toBe("failed");
  });

  it("refreshes the target placeholder inventory", () => {
    const edited = recomputeRow(rowFor("hud.floorLabel"), "Ebene {n} / {max}", ctx);
    expect(edited.targetPlaceholders.map((p) => p.raw)).toEqual(["{n}", "{max}"]);
  });
});

describe("revert and tidy", () => {
  it("reverts to the model output and drops the edited flag", () => {
    const row = rowFor("menu.play");
    const edited = recomputeRow(row, "Spielen!", ctx);
    const reverted = revertRow(edited, ctx);
    expect(reverted.target).toBe(row.modelTarget);
    expect(reverted.edited).toBe(false);
  });

  it("applies the free deterministic fixes a human edit introduces", () => {
    const row = recomputeRow(rowFor("menu.play"), '  "Spielen"  ', ctx);
    const tidied = tidyRow(row, ctx);
    expect(tidied.target).not.toBe(row.target);
    expect(tidied.target.trim()).toBe(tidied.target);
  });

  it("leaves a clean row untouched, and returns the same object", () => {
    const row = recomputeRow(rowFor("menu.play"), "Spielen", ctx);
    expect(tidyRow(row, ctx)).toBe(row);
  });
});

describe("trimRowToFit", () => {
  it("brings an overflowing edit inside its budget", () => {
    const row = recomputeRow(
      rowFor("actions.endTurn"),
      "Diesen kompletten Spielzug jetzt endgültig beenden",
      ctx,
    );
    expect(row.fit?.verdict).toBe("overflow");

    const trimmed = trimRowToFit(row, ctx);
    expect(trimmed.fit?.verdict).not.toBe("overflow");
    expect(trimmed.target.length).toBeLessThan(row.target.length);
  });

  it("keeps placeholders whole while trimming", () => {
    const row = recomputeRow(
      rowFor("hud.floorLabel"),
      "Ebene {n} des tiefsten Kellerverlieses von Emberfall",
      ctx,
    );
    const trimmed = trimRowToFit(row, ctx);
    const opens = (trimmed.target.match(/\{/g) ?? []).length;
    const closes = (trimmed.target.match(/\}/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it("is a no-op for a row that already fits", () => {
    const row = recomputeRow(rowFor("menu.play"), "Spiel", ctx);
    expect(trimRowToFit(row, ctx)).toBe(row);
  });
});

describe("prompt-side views of a row", () => {
  it("builds the same unit shape the engine consumes", () => {
    const unit = unitForRow(rowFor("hud.floorLabel"), ctx);
    expect(unit.key).toBe("hud.floorLabel");
    expect(unit.source).toBe("Floor {n}");
    expect(unit.placeholders.map((p) => p.raw)).toEqual(["{n}"]);
    expect(unit.allowedWidth).toBeGreaterThan(0);
    expect(unit.budget.rationale.length).toBeGreaterThan(0);
  });

  it("shows the exact repair directive for a row that still needs one", () => {
    const broken = recomputeRow(rowFor("hud.floorLabel"), "Ebene", ctx);
    const feedback = repairFeedbackForRow(broken, ctx);
    expect(feedback).not.toBeNull();
    expect(feedback).toContain("hud.floorLabel");
    expect(feedback).toContain("{n}");
  });

  it("shows no repair directive for a row that does not warrant one", () => {
    const fine = recomputeRow(rowFor("hud.floorLabel"), "Ebene {n}", ctx);
    expect(repairFeedbackForRow(fine, ctx)).toBeNull();
  });

  it("always has a budget rationale to show", () => {
    for (const key of ["menu.play", "errors.saveFailed.body", "hud.hp"]) {
      expect(budgetRationaleForRow(rowFor(key), ctx).length).toBeGreaterThan(0);
    }
  });
});
