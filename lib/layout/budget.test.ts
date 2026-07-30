import { describe, expect, it } from "vitest";
import type { UiRole } from "@/lib/types";
import {
  absoluteHeadroomFor,
  allowedWidthFor,
  budgetForRole,
  describeBudgetForPrompt,
  effectiveRatioFor,
  planLength,
  roleSpec,
} from "./budget";
import { getLocaleProfile } from "./locales";
import { estimateWidth, measureText } from "./metrics";
import { makeRandom, pick, randomString } from "./testing";

const ALL_ROLES: readonly UiRole[] = [
  "button",
  "menu",
  "label",
  "placeholder",
  "tooltip",
  "title",
  "heading",
  "body",
  "error",
  "toast",
  "badge",
  "unknown",
];

const de = getLocaleProfile("de");
const fr = getLocaleProfile("fr");
const ja = getLocaleProfile("ja");
const zh = getLocaleProfile("zh-CN");
const fi = getLocaleProfile("fi");
const tr = getLocaleProfile("tr");
const ar = getLocaleProfile("ar");
const unknownLocale = getLocaleProfile("xx");

describe("budgetForRole — role ordering", () => {
  it("gives tighter chrome tighter ratios", () => {
    const source = "Save changes";
    const ratio = (role: UiRole) => budgetForRole(role, source, fr).maxRatio;
    expect(ratio("badge")).toBeLessThanOrEqual(ratio("button"));
    expect(ratio("button")).toBeLessThanOrEqual(ratio("menu"));
    expect(ratio("menu")).toBeLessThanOrEqual(ratio("label"));
    expect(ratio("label")).toBeLessThanOrEqual(ratio("heading"));
    expect(ratio("heading")).toBeLessThanOrEqual(ratio("error"));
    expect(ratio("error")).toBeLessThanOrEqual(ratio("tooltip"));
    expect(ratio("tooltip")).toBeLessThanOrEqual(ratio("body"));
  });

  it("matches the specified ratio bands for a low-expansion locale", () => {
    // Turkish (1.15) never lifts a role above its own ratio, so these are the
    // pure role numbers.
    const ratio = (role: UiRole) => budgetForRole(role, "Save changes", tr).maxRatio;
    expect(ratio("badge")).toBeCloseTo(1.15, 2);
    expect(ratio("button")).toBeCloseTo(1.2, 2);
    expect(ratio("menu")).toBeCloseTo(1.25, 2);
    expect(ratio("label")).toBeCloseTo(1.3, 2);
    expect(ratio("placeholder")).toBeCloseTo(1.3, 2);
    expect(ratio("heading")).toBeCloseTo(1.35, 2);
    expect(ratio("error")).toBeCloseTo(1.5, 2);
    expect(ratio("toast")).toBeCloseTo(1.5, 2);
    expect(ratio("tooltip")).toBeCloseTo(1.6, 2);
    expect(ratio("body")).toBeCloseTo(1.8, 2);
  });

  it("caps hard character ceilings only where the chrome implies one", () => {
    for (const role of ["button", "badge", "menu", "label", "placeholder", "title", "heading"] as const) {
      expect(budgetForRole(role, "Save changes", de).maxChars).not.toBeNull();
    }
    for (const role of ["tooltip", "body", "error", "toast", "unknown"] as const) {
      expect(budgetForRole(role, "Save changes", de).maxChars).toBeNull();
    }
  });
});

describe("budgetForRole — the locale blend", () => {
  it("never budgets below the locale's own natural expansion", () => {
    // The thrash guard: a German button must be allowed its 35%.
    expect(budgetForRole("button", "Save changes", de).maxRatio).toBeCloseTo(1.35, 2);
    expect(budgetForRole("badge", "Save changes", fi).maxRatio).toBeCloseTo(1.3, 2);
    expect(budgetForRole("badge", "Save changes", de).maxRatio).toBeCloseTo(1.3, 2);
  });

  it("caps the locale term at the role's ceiling", () => {
    // German expansion (1.35) exceeds the badge ceiling (1.30) and is clamped.
    expect(effectiveRatioFor("badge", de)).toBe(roleSpec("badge").ceiling);
    expect(effectiveRatioFor("badge", de)).toBeLessThan(de.expansion);
  });

  it("never penalises a locale for being naturally shorter", () => {
    // Japanese expands to 0.60x in characters; the role floor still applies.
    expect(budgetForRole("button", "Save changes", ja).maxRatio).toBeCloseTo(1.2, 2);
    expect(budgetForRole("body", "Save changes", ja).maxRatio).toBeCloseTo(1.8, 2);
  });

  it("implements max(roleRatio, min(expansion, ceiling)) exactly", () => {
    const random = makeRandom(31337);
    const profiles = [de, fr, ja, zh, fi, tr, ar, unknownLocale];
    for (let i = 0; i < 400; i += 1) {
      const role = pick(random, ALL_ROLES.filter((r) => r !== "unknown"));
      const profile = pick(random, profiles);
      const spec = roleSpec(role);
      const expected = Math.max(
        spec.ratio,
        Math.min(profile.expansion, spec.ceiling),
      );
      expect(effectiveRatioFor(role, profile)).toBeCloseTo(expected, 3);
    }
  });

  it("falls back to the locale's expansion plus a margin for unknown roles", () => {
    expect(effectiveRatioFor("unknown", de)).toBeCloseTo(1.55, 2); // 1.35 + 0.20
    expect(effectiveRatioFor("unknown", tr)).toBeCloseTo(1.35, 2); // floor
    expect(effectiveRatioFor("unknown", ja)).toBeCloseTo(1.35, 2); // floor
    // ...but never beyond the role ceiling.
    expect(effectiveRatioFor("unknown", de)).toBeLessThanOrEqual(
      roleSpec("unknown").ceiling,
    );
  });
});

describe("budgetForRole — absolute headroom for very short sources", () => {
  const SHORT = ["OK", "Go", "Hi", "No"] as const;

  it("grants short sources real room, not ratio room", () => {
    for (const source of SHORT) {
      const sourceWidth = estimateWidth(source, de);
      const allowed = allowedWidthFor(source, "button", de);
      // Ratio alone would be useless here.
      expect(allowed).toBeGreaterThan(sourceWidth * 1.35);
      // Enough for a genuinely different word, not just one more letter.
      expect(allowed - sourceWidth).toBeGreaterThan(1.5);
    }
  });

  it("lets real short-button translations through", () => {
    const cases: Array<[string, string, string]> = [
      ["de", "OK", "Fertig"],
      ["de", "Go", "Los"],
      ["de", "No", "Nein"],
      ["fr", "OK", "Valider"],
      ["fr", "Go", "Aller"],
      ["es", "No", "No"],
      ["ru", "Hi", "Привет"],
    ];
    for (const [locale, source, target] of cases) {
      const profile = getLocaleProfile(locale);
      const allowed = allowedWidthFor(source, "button", profile);
      expect(
        estimateWidth(target, profile),
        `${locale}: "${source}" -> "${target}"`,
      ).toBeLessThanOrEqual(allowed);
    }
  });

  it("decays the allowance as the source gets longer", () => {
    const widths = [0, 2, 5, 10, 20, 40];
    const headrooms = widths.map((w) => absoluteHeadroomFor("button", w));
    for (let i = 1; i < headrooms.length; i += 1) {
      expect(headrooms[i] ?? 0).toBeLessThan(headrooms[i - 1] ?? 0);
    }
    // By the time the source is long, ratio room dominates entirely.
    const long = "Delete this workspace and everything inside it";
    expect(allowedWidthFor(long, "button", de)).toBeCloseTo(
      estimateWidth(long, de) * 1.35,
      1,
    );
  });

  it("gives a short source a maxChars well above its own length", () => {
    for (const source of SHORT) {
      const budget = budgetForRole("button", source, de);
      expect(budget.maxChars).not.toBeNull();
      expect(budget.maxChars ?? 0).toBeGreaterThanOrEqual(source.length + 3);
    }
  });

  it("does not hand CJK Latin-style character headroom", () => {
    // "OK" in Japanese must not be told it may use 6 characters: 6 CJK glyphs
    // are 11.7em, nearly three times the button budget.
    const budget = budgetForRole("button", "OK", ja);
    expect(budget.maxChars).toBeLessThanOrEqual(3);
    expect(budget.maxChars).toBeGreaterThanOrEqual(2);
  });
});

describe("budgetForRole — invariants (property)", () => {
  it("always produces a usable budget for any role, locale and source", () => {
    const random = makeRandom(0xbadc0de);
    const profiles = [de, fr, ja, zh, fi, tr, ar, unknownLocale];
    for (let i = 0; i < 1500; i += 1) {
      const role = pick(random, ALL_ROLES);
      const profile = pick(random, profiles);
      const source = randomString(random, 24);
      const budget = budgetForRole(role, source, profile);
      const allowed = allowedWidthFor(source, role, profile);
      const sourceWidth = estimateWidth(source, profile);

      expect(Number.isFinite(budget.maxRatio)).toBe(true);
      expect(budget.maxRatio).toBeGreaterThanOrEqual(1.0);
      expect(budget.graceRatio).toBeGreaterThan(1.0);
      expect(budget.rationale.length).toBeGreaterThan(20);
      // A budget that does not admit the source itself is unsatisfiable.
      expect(allowed).toBeGreaterThanOrEqual(sourceWidth);
      if (budget.maxChars !== null) {
        expect(budget.maxChars).toBeGreaterThanOrEqual(1);
        if (!zhLike(profile)) {
          expect(budget.maxChars).toBeGreaterThanOrEqual(
            measureText(source, profile).charCount,
          );
        }
      }
    }
  });

  function zhLike(profile: { glyphWidth: number }): boolean {
    return profile.glyphWidth >= 1.5;
  }

  it("handles the empty source without producing NaN", () => {
    for (const role of ALL_ROLES) {
      const budget = budgetForRole(role, "", de);
      expect(Number.isFinite(budget.maxRatio)).toBe(true);
      expect(allowedWidthFor("", role, de)).toBeGreaterThan(0);
    }
  });
});

describe("planLength", () => {
  it("agrees with the individual helpers", () => {
    const plan = planLength("Save changes", "button", de);
    expect(plan.budget).toEqual(budgetForRole("button", "Save changes", de));
    expect(plan.allowedWidth).toBe(allowedWidthFor("Save changes", "button", de));
    expect(plan.sourceWidth).toBe(estimateWidth("Save changes", de));
    expect(plan.suggestedMaxChars).toBe(plan.budget.maxChars);
  });

  it("supplies a character suggestion even where maxChars is null", () => {
    const plan = planLength("Something went wrong.", "toast", de);
    expect(plan.budget.maxChars).toBeNull();
    expect(plan.suggestedMaxChars).toBeGreaterThan(0);
  });

  it("uses the widest line for multi-line body copy", () => {
    const single = planLength("A short line", "body", de);
    const multi = planLength("A short line\nA short line", "body", de);
    expect(multi.sourceWidth).toBeCloseTo(single.sourceWidth, 3);
  });
});

describe("rationale copy", () => {
  it("names the chrome, the language and the ceiling", () => {
    const rationale = budgetForRole("button", "Save changes", de).rationale;
    expect(rationale).toContain("Button chrome");
    expect(rationale).toContain("German");
    expect(rationale).toContain("35%");
    expect(rationale).toContain("1.35x");
    expect(rationale).toMatch(/about \d+ characters/);
  });

  it("explains when the absolute allowance decided the budget", () => {
    expect(budgetForRole("button", "OK", de).rationale).toContain(
      "fixed minimum allowance",
    );
    expect(
      budgetForRole("button", "Delete this entire workspace forever", de).rationale,
    ).not.toContain("fixed minimum allowance");
  });

  it("describes CJK as shorter but wider", () => {
    const rationale = budgetForRole("button", "Save changes", ja).rationale;
    expect(rationale).toContain("fewer characters");
    expect(rationale).toContain("1.95x as wide");
  });
});

describe("describeBudgetForPrompt", () => {
  it("produces a concrete, plain-language instruction", () => {
    const budget = budgetForRole("button", "Save changes", de);
    const text = describeBudgetForPrompt(budget, de, "Save changes", "button");
    expect(text).toMatch(/^Maximum \d+ characters/);
    expect(text).toContain("fixed-width");
    expect(text).toContain("The source is 12 characters.");
  });

  it("warns explicitly about CJK glyph width", () => {
    const budget = budgetForRole("button", "Save changes", ja);
    const text = describeBudgetForPrompt(budget, ja, "Save changes", "button");
    expect(text).toContain("1.95x as wide");
  });

  it("works without a role and still gives a number", () => {
    const budget = budgetForRole("body", "Welcome to the app.", de);
    const text = describeBudgetForPrompt(budget, de, "Welcome to the app.");
    expect(text).toMatch(/^Maximum \d+ characters/);
    expect(text).not.toContain("NaN");
  });

  it("never emits a limit below the source length", () => {
    const random = makeRandom(2024);
    for (let i = 0; i < 300; i += 1) {
      const role = pick(random, ALL_ROLES);
      const source = randomString(random, 20, ["a", "b", "c", " ", "M"]);
      const budget = budgetForRole(role, source, de);
      const text = describeBudgetForPrompt(budget, de, source, role);
      const match = /^Maximum (\d+) characters/.exec(text);
      expect(match).not.toBeNull();
      const limit = Number(match?.[1] ?? "0");
      expect(limit).toBeGreaterThanOrEqual(
        measureText(source, de).charCount,
      );
    }
  });

  it("uses the singular for a one-character source", () => {
    const budget = budgetForRole("badge", "1", de);
    expect(describeBudgetForPrompt(budget, de, "1", "badge")).toContain(
      "The source is 1 character.",
    );
  });
});
