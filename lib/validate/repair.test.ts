import { describe, expect, it } from "vitest";
import { extractPlaceholders } from "@/lib/core";
import type { FitResult, Issue, LengthBudget, TranslationUnit } from "@/lib/types";
import { classify, issue } from "./errors";
import {
  MODEL_REPAIRABLE_CODES,
  assessRepair,
  budgetExhaustedIssue,
  buildRepairFeedback,
  isModelRepairable,
  needsRepair,
  resolveFinalStatus,
} from "./repair";
import { issuesFromFit, validatePlaceholderParity } from "./validators";

const BUTTON_BUDGET: LengthBudget = {
  maxRatio: 1.3,
  maxChars: 18,
  graceRatio: 1.05,
  rationale: "button labels sit in a fixed-width control",
};

function unitFor(
  source: string,
  overrides: Partial<TranslationUnit> = {},
): TranslationUnit {
  return {
    key: "actions.save",
    source,
    role: "button",
    placeholders: extractPlaceholders(source),
    ambiguities: [],
    budget: BUTTON_BUDGET,
    allowedWidth: 5.2,
    neighbors: ["actions.cancel", "actions.discard"],
    ...overrides,
  };
}

function fitOf(
  verdict: FitResult["verdict"],
  overrides: Partial<FitResult> = {},
): FitResult {
  return {
    verdict,
    sourceWidth: 4.1,
    targetWidth: 9.4,
    ratio: 2.29,
    budget: BUTTON_BUDGET,
    allowedWidth: 5.2,
    overBy: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("needsRepair / assessRepair", () => {
  it("does not repair a clean entry", () => {
    expect(needsRepair([], null)).toBe(false);
    expect(assessRepair([], null).reason).toContain("Clean");
  });

  it("does not repair warnings and info alone", () => {
    const issues: Issue[] = [
      classify("whitespace-drift", "lost a space"),
      classify("untranslated", "same as source"),
      classify("casing-drift", "lowercased"),
      classify("length-tight", "snug"),
    ];
    expect(needsRepair(issues, fitOf("tight"))).toBe(false);
    expect(assessRepair(issues, null).blocking).toEqual([]);
  });

  it("repairs on any blocking error", () => {
    const issues = [classify("placeholder-missing", "{count} is gone")];
    expect(needsRepair(issues, null)).toBe(true);
    expect(assessRepair(issues, null).reason).toContain("placeholder-missing");
  });

  it("repairs on an overflow verdict even with no recorded issue", () => {
    expect(needsRepair([], fitOf("overflow"))).toBe(true);
    expect(assessRepair([], fitOf("overflow")).reason).toContain("overflow");
  });

  it("does not repair an error a model cannot fix", () => {
    // Re-prompting will not undo a structural divergence in the tree.
    expect(needsRepair([classify("structure-mismatch", "extra key")], null)).toBe(false);
  });

  it("classifies which codes a second pass can fix", () => {
    expect(isModelRepairable("placeholder-missing")).toBe(true);
    expect(isModelRepairable("length-overflow")).toBe(true);
    expect(isModelRepairable("invalid-json")).toBe(false);
    expect(isModelRepairable("provider-error")).toBe(false);
    expect(MODEL_REPAIRABLE_CODES.has("untranslated")).toBe(true);
  });

  it("reports an info-only entry as not worth a model call", () => {
    const reordered = validatePlaceholderParity("{a} {b}", "{b} {a}");
    expect(needsRepair(reordered, null)).toBe(false);
  });

  it("repairs reordered POSITIONAL printf, which is an error", () => {
    const reordered = validatePlaceholderParity("%s wrote %d", "%d von %s");
    expect(needsRepair(reordered, null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("buildRepairFeedback", () => {
  it("states the exact overflow arithmetic and forbids truncation", () => {
    const unit = unitFor("Save changes");
    const previous = "Alle Änderungen sichern!"; // 24 characters
    const fit = fitOf("overflow", { overBy: 3 });
    const feedback = buildRepairFeedback(unit, previous, issuesFromFit(fit), fit);

    expect(feedback).toContain("was 24 characters");
    expect(feedback).toContain("button budget is 18");
    expect(feedback).toContain("Cut at least 6 characters");
    expect(feedback).toContain("Do not truncate or add an ellipsis");
    expect(feedback).toContain("Hard limit: 18 characters");
  });

  it("derives a character ceiling from em widths when there is no hard cap", () => {
    const budget: LengthBudget = { ...BUTTON_BUDGET, maxChars: null };
    const unit = unitFor("Save", { budget, role: "label" });
    const previous = "Alle Änderungen sichern!"; // 24 chars
    const fit = fitOf("overflow", { budget, targetWidth: 12, allowedWidth: 6, overBy: 1 });
    const feedback = buildRepairFeedback(unit, previous, [], fit);

    // 24 chars at 12em ⇒ 0.5em/char, so 6em of budget is 12 characters.
    expect(feedback).toContain("was 24 characters");
    expect(feedback).toContain("budget is 12");
    expect(feedback).toContain("Cut at least 12 characters");
    expect(feedback).toContain("Target length: at most 12 characters");
  });

  it("names the exact missing placeholder", () => {
    const unit = unitFor("Delete {count} items");
    const issues = validatePlaceholderParity(unit.source, "Elemente löschen", {
      key: unit.key,
    });
    const feedback = buildRepairFeedback(unit, "Elemente löschen", issues, null);

    expect(feedback).toContain("{count} is missing");
    expect(feedback).toContain("exactly once");
    expect(feedback).toContain("Do not translate the text inside it");
    expect(feedback).toContain(
      "Placeholders that must appear exactly as written: {count}",
    );
  });

  it("states the required repeat count for a multiply-used placeholder", () => {
    const unit = unitFor("{name} invited {name}");
    const issues = validatePlaceholderParity(unit.source, "{name} hat eingeladen");
    const feedback = buildRepairFeedback(unit, "{name} hat eingeladen", issues, null);

    expect(feedback).toContain("exactly 2 times");
    expect(feedback).toContain("{name} ×2");
  });

  it("tells the model to remove an invented placeholder", () => {
    const unit = unitFor("Welcome back");
    const issues = validatePlaceholderParity(unit.source, "Willkommen, {name}");
    const feedback = buildRepairFeedback(unit, "Willkommen, {name}", issues, null);

    expect(feedback).toContain("{name}");
    expect(feedback).toContain("does not exist in the source");
    expect(feedback).toContain("Remove it");
  });

  it("explains a malformed placeholder with the correct spelling", () => {
    const unit = unitFor("Save {count} items");
    const issues = validatePlaceholderParity(unit.source, "Speichere {count Elemente");
    const feedback = buildRepairFeedback(unit, "Speichere {count Elemente", issues, null);
    expect(feedback).toContain("{count}");
    expect(feedback.toLowerCase()).toContain("exactly");
  });

  it("explains why positional printf order is load-bearing", () => {
    const unit = unitFor("%s wrote %d comments");
    const issues = validatePlaceholderParity(unit.source, "%d Kommentare von %s");
    const feedback = buildRepairFeedback(unit, "%d Kommentare von %s", issues, null);
    expect(feedback).toContain("filled by position");
    expect(feedback).toContain("rearrange the words around them");
  });

  it("handles empty output", () => {
    const unit = unitFor("Save");
    const feedback = buildRepairFeedback(
      unit,
      "",
      [classify("empty-translation", "empty")],
      null,
    );
    expect(feedback).toContain("You returned an empty string");
    expect(feedback).toContain('"Save"');
  });

  it("handles untranslated output", () => {
    const unit = unitFor("Save");
    const feedback = buildRepairFeedback(
      unit,
      "Save",
      [issue("untranslated", "error", "identical to source")],
      null,
    );
    expect(feedback).toContain("identical to the source");
    expect(feedback).toContain("glossary");
  });

  it("covers tag imbalance with the exact tag to add", () => {
    const unit = unitFor("Click <b>here</b>");
    const feedback = buildRepairFeedback(
      unit,
      "Klicke <b>hier",
      [
        classify("tag-imbalance", "unclosed", {
          detail: { tag: "<b>", expected: "</b>", reason: "unclosed" },
        }),
      ],
      null,
    );
    expect(feedback).toContain("<b>");
    expect(feedback).toContain("</b>");
  });

  it("covers control characters by code point", () => {
    const unit = unitFor("Save");
    const feedback = buildRepairFeedback(
      unit,
      "Speichern",
      [
        classify("control-characters", "bell", {
          detail: { codePoint: "U+0007" },
        }),
      ],
      null,
    );
    expect(feedback).toContain("U+0007");
  });

  it("always ends with the output-format constraint", () => {
    const feedback = buildRepairFeedback(unitFor("Save"), "x", [], null);
    expect(feedback).toContain("Return the translated string only");
    expect(feedback).toContain("no code fence");
  });

  it("quotes the rejected attempt so the model can see what it wrote", () => {
    const feedback = buildRepairFeedback(unitFor("Save"), "Speichern  ", [], null);
    expect(feedback).toContain('"Speichern  "');
    expect(feedback).toContain("actions.save");
  });

  it("numbers the directives and does not repeat one", () => {
    const unit = unitFor("Save {count} items");
    const fit = fitOf("overflow");
    const issues = [
      ...issuesFromFit(fit),
      ...issuesFromFit(fit),
      ...validatePlaceholderParity(unit.source, "Speichere"),
    ];
    const feedback = buildRepairFeedback(unit, "Speichere", issues, fit);
    const numbered = feedback.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(numbered).toHaveLength(2);
    expect(numbered[0]).toContain("1. Your previous attempt");
  });

  it("drops warnings when errors are present, to keep the prompt focused", () => {
    const unit = unitFor("Save {count} items");
    const issues = [
      ...validatePlaceholderParity(unit.source, "Speichere"),
      classify("casing-drift", "lowercased"),
    ];
    const feedback = buildRepairFeedback(unit, "Speichere", issues, null);
    expect(feedback).not.toContain("styling for this button");
  });

  it("still says something useful when there are no issues at all", () => {
    const feedback = buildRepairFeedback(unitFor("Save"), "Speichern", [], null);
    expect(feedback).toContain("Your previous attempt was rejected");
  });

  it("omits the placeholder constraint for strings that have none", () => {
    const feedback = buildRepairFeedback(unitFor("Settings"), "Einstellungen", [], null);
    expect(feedback).not.toContain("Placeholders that must appear");
  });
});

// ---------------------------------------------------------------------------

describe("resolveFinalStatus", () => {
  it("passes a clean entry", () => {
    expect(resolveFinalStatus([], null)).toBe("passed");
    expect(resolveFinalStatus([], fitOf("fits"))).toBe("passed");
  });

  it("flags an entry that only carries warnings or info", () => {
    expect(resolveFinalStatus([classify("whitespace-drift", "x")], null)).toBe("flagged");
    expect(resolveFinalStatus([classify("casing-drift", "x")], null)).toBe("flagged");
  });

  it("flags a clean entry with no layout headroom", () => {
    expect(resolveFinalStatus([], fitOf("tight"))).toBe("flagged");
  });

  it("fails an entry with a surviving error", () => {
    expect(resolveFinalStatus([classify("placeholder-missing", "x")], fitOf("fits"))).toBe(
      "failed",
    );
  });

  it("fails an entry that still overflows, even with no issue recorded", () => {
    // Quality bar #1: a translation that overflows is never reported as passing.
    expect(resolveFinalStatus([], fitOf("overflow"))).toBe("failed");
  });

  it("prefers failed over flagged when both apply", () => {
    expect(
      resolveFinalStatus(
        [classify("casing-drift", "x"), classify("empty-translation", "y")],
        null,
      ),
    ).toBe("failed");
  });
});

describe("budgetExhaustedIssue", () => {
  it("explains why a broken entry was delivered", () => {
    const result = budgetExhaustedIssue("actions.save", 3, 2);
    expect(result.code).toBe("budget-exhausted");
    expect(result.severity).toBe("warning");
    expect(result.key).toBe("actions.save");
    expect(result.detail).toEqual({ attempts: 3, maxRepairAttempts: 2 });
  });

  it("does not by itself fail an entry", () => {
    expect(resolveFinalStatus([budgetExhaustedIssue("a", 3, 2)], null)).toBe("flagged");
  });
});
