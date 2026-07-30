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
import { evaluateFit } from "./fit";
import { LOCALE_PROFILES, getLocaleProfile } from "./locales";
import { estimateWidth, measureText } from "./metrics";
import { makeRandom, pick, randomString, typicalCharOf } from "./testing";

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
    // "OK" as a Japanese button: allowedWidth is 4.525em and a Japanese glyph
    // is one em box (1.95 mean-Latin characters x 0.55em = 1.0725em), so
    // exactly four characters fit. The limit is derived from measurement, not
    // from Latin-style character headroom: anything above what the width
    // admits instructs the model to overflow and then rejects it for obeying.
    const budget = budgetForRole("button", "OK", ja);
    expect(budget.maxChars).toBe(4);
    expect(estimateWidth("定".repeat(4), ja)).toBeLessThanOrEqual(
      allowedWidthFor("OK", "button", ja),
    );
    expect(estimateWidth("定".repeat(5), ja)).toBeGreaterThan(
      allowedWidthFor("OK", "button", ja),
    );
  });
});

// ---------------------------------------------------------------------------
// The load-bearing invariant: the budget half and the fit half must agree.
// ---------------------------------------------------------------------------

describe("budgetForRole — coherence with evaluateFit (property)", () => {
  /**
   * `describeBudgetForPrompt` puts `maxChars` in front of the model as
   * "Maximum N characters", i.e. a limit it is entitled to spend in full. So
   * the most charitable translation the model can return at that limit — N
   * ordinary letters of the target script, no wide capitals, no punctuation —
   * must not then be rejected by `evaluateFit`.
   *
   * When this fails the module contradicts itself on its main path: the prompt
   * asks for a string, the fit engine rejects it, the repair loop burns its
   * attempts arguing with an instruction the module wrote, and `enforceFit`
   * clips the survivor mid-word. That is the exact failure the length engine
   * exists to prevent, so it is checked exhaustively rather than by sampling:
   * every catalog locale x every capped role x a spread of real UI sources.
   */
  const CAPPED_ROLES: readonly UiRole[] = ALL_ROLES.filter(
    (role) => roleSpec(role).hardCap !== null,
  );

  const SOURCES = [
    "OK", // 2 chars: absolute headroom dominates
    "Save",
    "Cancel",
    "Settings", // narrow lowercase — mean advance well under the Latin baseline
    "Export data",
    "Sign in with Google", // long enough that the ratio term dominates
  ] as const;

  it("never advertises a limit that evaluateFit rejects", () => {
    const codes = Object.keys(LOCALE_PROFILES);
    // Guards the loop itself: an empty catalog would make this vacuously green.
    expect(codes.length).toBeGreaterThanOrEqual(48);
    expect(CAPPED_ROLES.length).toBeGreaterThanOrEqual(7);

    let combinations = 0;
    for (const code of codes) {
      const profile = LOCALE_PROFILES[code];
      if (profile === undefined) continue;
      const letter = typicalCharOf(profile);

      for (const role of CAPPED_ROLES) {
        for (const source of SOURCES) {
          const budget = budgetForRole(role, source, profile);
          const limit = budget.maxChars;
          expect(limit).not.toBeNull();
          if (limit === null) continue;

          combinations += 1;
          const target = letter.repeat(limit);
          const fit = evaluateFit(source, target, role, profile);

          expect(
            fit.verdict,
            `${code}/${role} "${source}": maxChars=${limit} renders at ` +
              `${fit.targetWidth}em against allowedWidth ${fit.allowedWidth}em`,
          ).not.toBe("overflow");
        }
      }
    }
    expect(combinations).toBeGreaterThanOrEqual(1764);
  });

  it("keeps the same promise for the number planLength suggests", () => {
    // `suggestedMaxChars` is the same number for wrapping roles, where
    // `maxChars` is null but the prompt engine still wants a figure.
    for (const code of Object.keys(LOCALE_PROFILES)) {
      const profile = LOCALE_PROFILES[code];
      if (profile === undefined) continue;
      const letter = typicalCharOf(profile);
      for (const role of ALL_ROLES) {
        for (const source of ["OK", "Settings", "Export data"] as const) {
          const plan = planLength(source, role, profile);
          const fit = evaluateFit(
            source,
            letter.repeat(plan.suggestedMaxChars),
            role,
            profile,
          );
          expect(
            fit.verdict,
            `${code}/${role} "${source}": suggestedMaxChars=${plan.suggestedMaxChars}`,
          ).not.toBe("overflow");
        }
      }
    }
  });

  it("keeps the promise the prompt copy actually makes", () => {
    // The number the model sees is the one parsed out of the instruction, not
    // `budget.maxChars` directly — describeBudgetForPrompt has its own
    // fallback path when `maxChars` is null.
    for (const code of ["de", "ja", "ko", "zh-CN", "ru", "ar", "fi", "el"]) {
      const profile = LOCALE_PROFILES[code];
      if (profile === undefined) throw new Error(`missing profile ${code}`);
      const letter = typicalCharOf(profile);
      for (const role of ALL_ROLES.filter((r) => roleSpec(r).hardCap !== null)) {
        for (const source of ["OK", "Save", "Settings", "Export data"] as const) {
          const budget = budgetForRole(role, source, profile);
          const copy = describeBudgetForPrompt(budget, profile, source, role);
          const match = /^Maximum (\d+) characters/.exec(copy);
          expect(match, copy).not.toBeNull();
          const stated = Number(match?.[1] ?? "0");
          const fit = evaluateFit(source, letter.repeat(stated), role, profile);
          expect(fit.verdict, `${code}/${role} "${source}": ${copy}`).not.toBe(
            "overflow",
          );
        }
      }
    }
  });

  it("is conservative for full-width scripts specifically", () => {
    // The regression that motivated all of the above: maxChars was derived
    // from a 50/50 blend of the CJK em square and the *English* source's mean
    // advance, overstating the real limit for every ja/ko/zh combination.
    // Pin the corrected numbers so the blend cannot creep back.
    //
    // These are the counts the *em box* admits — a full-width glyph is one em
    // (ja 1.073em), not 1.95em. The inflated advance produced 1 and 2 here,
    // limits no Japanese or Chinese string of any meaning can satisfy.
    const cases: Array<[string, UiRole, string, number]> = [
      ["ja", "button", "Save", 4],
      ["ja", "badge", "Save", 3],
      ["ko", "badge", "Settings", 4],
      ["zh-CN", "button", "OK", 4],
    ];
    for (const [code, role, source, expected] of cases) {
      const profile = LOCALE_PROFILES[code];
      if (profile === undefined) throw new Error(`missing profile ${code}`);
      expect(
        budgetForRole(role, source, profile).maxChars,
        `${code}/${role} "${source}"`,
      ).toBe(expected);
    }
  });

  it("still lets a full-width limit use the width it is given", () => {
    // Conservative must not collapse into useless: the advertised limit has to
    // stay within one glyph of everything that physically fits, otherwise the
    // model is aimed so short that it drops meaning.
    for (const code of ["ja", "ko", "zh-CN", "zh-TW"]) {
      const profile = LOCALE_PROFILES[code];
      if (profile === undefined) throw new Error(`missing profile ${code}`);
      const letter = typicalCharOf(profile);
      for (const role of ["button", "badge", "menu", "label"] as const) {
        for (const source of ["OK", "Save", "Settings", "Export data"] as const) {
          const limit = budgetForRole(role, source, profile).maxChars ?? 0;
          const allowed = allowedWidthFor(source, role, profile);
          // One more glyph than advertised must genuinely not fit.
          expect(
            estimateWidth(letter.repeat(limit + 1), profile),
            `${code}/${role} "${source}" is aimed too short at ${limit}`,
          ).toBeGreaterThan(allowed);
        }
      }
    }
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
        // The advertised limit must be spendable in full, whatever the source
        // looks like. Stated in width rather than in character count on
        // purpose: count is not the authority here and never was. A source
        // built from unusually narrow glyphs (i, l, ".") or from zero-width
        // marks genuinely does not buy room for that many *typical* target
        // characters, so `maxChars >= sourceChars` is not a property this
        // engine can honour — and asserting it would force the budget to
        // advertise a limit `evaluateFit` then rejects, which is precisely the
        // self-contradiction the coherence suite above exists to forbid.
        const target = typicalCharOf(profile).repeat(budget.maxChars);
        expect(
          evaluateFit(source, target, role, profile).verdict,
          `${profile.code}/${role} ${JSON.stringify(source)}: maxChars=${budget.maxChars}`,
        ).not.toBe("overflow");
      }
    }
  });

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
