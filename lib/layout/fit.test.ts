import { describe, expect, it } from "vitest";
import type { UiRole } from "@/lib/types";
import { allowedWidthFor, budgetForRole } from "./budget";
import {
  budgetFor,
  describeFitForRepair,
  enforceFit,
  evaluateFit,
  truncateToWidth,
  verdictFor,
} from "./fit";
import { getLocaleProfile } from "./locales";
import { estimateLongestLineWidth, estimateWidth } from "./metrics";
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
const ru = getLocaleProfile("ru");
const ja = getLocaleProfile("ja");
const zh = getLocaleProfile("zh-CN");
const ar = getLocaleProfile("ar");
const he = getLocaleProfile("he");
const th = getLocaleProfile("th");
const PROFILES = [de, fr, ru, ja, zh, ar, he, th];

describe("evaluateFit — shape", () => {
  it("fills every field of FitResult", () => {
    const fit = evaluateFit("Save", "Speichern", "button", de);
    expect(Object.keys(fit).sort()).toEqual(
      [
        "allowedWidth",
        "budget",
        "overBy",
        "ratio",
        "sourceWidth",
        "targetWidth",
        "verdict",
      ].sort(),
    );
    expect(fit.budget).toEqual(budgetForRole("button", "Save", de));
    expect(fit.sourceWidth).toBe(estimateWidth("Save", de));
    expect(fit.targetWidth).toBe(estimateWidth("Speichern", de));
    expect(fit.allowedWidth).toBe(allowedWidthFor("Save", "button", de));
    expect(fit.ratio).toBeCloseTo(fit.targetWidth / fit.sourceWidth, 3);
  });

  it("is JSON-safe for every input", () => {
    const random = makeRandom(9001);
    for (let i = 0; i < 500; i += 1) {
      const fit = evaluateFit(
        randomString(random, 12),
        randomString(random, 20),
        pick(random, ALL_ROLES),
        pick(random, PROFILES),
      );
      const round = JSON.parse(JSON.stringify(fit)) as typeof fit;
      expect(round).toEqual(fit);
      expect(Number.isFinite(fit.ratio)).toBe(true);
      expect(Number.isFinite(fit.targetWidth)).toBe(true);
      expect(Number.isFinite(fit.allowedWidth)).toBe(true);
    }
  });
});

describe("evaluateFit — verdicts", () => {
  it("passes real-world translations that genuinely fit", () => {
    const cases: Array<[string, string, string, UiRole]> = [
      ["de", "Save", "Speichern", "button"],
      ["de", "Cancel", "Abbrechen", "button"],
      ["de", "Delete", "Löschen", "button"],
      ["de", "Settings", "Einstellungen", "menu"],
      ["de", "Next", "Weiter", "button"],
      ["fr", "Settings", "Paramètres", "menu"],
      ["ru", "Cancel", "Отмена", "button"],
      ["pl", "Save", "Zapisz", "button"],
      ["tr", "Save", "Kaydet", "button"],
      ["pt-BR", "Save", "Salvar", "button"],
      ["fi", "Save", "Tallenna", "button"],
      ["ja", "Save", "保存", "button"],
      ["zh-CN", "Settings", "设置", "menu"],
      ["ko", "Save", "저장", "button"],
      ["ar", "Save", "حفظ", "button"],
      ["he", "Save", "שמור", "button"],
    ];
    for (const [locale, source, target, role] of cases) {
      const fit = evaluateFit(source, target, role, getLocaleProfile(locale));
      expect(
        fit.verdict,
        `${locale} ${role} "${source}" -> "${target}" (${fit.targetWidth}em vs ${fit.allowedWidth}em)`,
      ).not.toBe("overflow");
    }
  });

  it("flags translations that would genuinely break the chrome", () => {
    const cases: Array<[string, string, string, UiRole]> = [
      ["de", "OK", "Bestätigen", "button"],
      ["de", "OK", "Registrierung abschließen", "button"],
      ["de", "Free", "Kostenlos", "badge"],
      ["de", "Save", "Alle Änderungen speichern", "button"],
      ["ja", "OK", "キャンセルする", "button"],
    ];
    for (const [locale, source, target, role] of cases) {
      const fit = evaluateFit(source, target, role, getLocaleProfile(locale));
      expect(
        fit.verdict,
        `${locale} ${role} "${source}" -> "${target}"`,
      ).toBe("overflow");
      expect(fit.overBy).toBeGreaterThan(0);
    }
  });

  it("uses 'tight' as the shippable warning band", () => {
    const budget = budgetForRole("button", "Save", de);
    const allowed = allowedWidthFor("Save", "button", de);
    expect(verdictFor(allowed, allowed, budget.graceRatio)).toBe("fits");
    expect(verdictFor(allowed + 0.001, allowed, budget.graceRatio)).toBe("tight");
    expect(
      verdictFor(allowed * budget.graceRatio, allowed, budget.graceRatio),
    ).toBe("tight");
    expect(
      verdictFor(allowed * budget.graceRatio + 0.01, allowed, budget.graceRatio),
    ).toBe("overflow");
  });

  it("never punishes a locale for being naturally short", () => {
    for (const [locale, target] of [
      ["ja", "保存"],
      ["zh-CN", "保存"],
      ["ar", "حفظ"],
      ["he", "שמור"],
    ] as const) {
      expect(evaluateFit("Save", target, "button", getLocaleProfile(locale)).verdict).toBe(
        "fits",
      );
    }
  });

  it("handles the empty and identical cases sanely", () => {
    expect(evaluateFit("", "", "button", de).verdict).toBe("fits");
    expect(evaluateFit("", "", "button", de).ratio).toBe(1);
    expect(evaluateFit("Save", "", "button", de).verdict).toBe("fits");
    expect(evaluateFit("Save", "Save", "button", de).verdict).toBe("fits");
    expect(evaluateFit("", "Very long translation", "button", de).ratio).toBe(99);
  });
});

describe("evaluateFit — invariants (property)", () => {
  it("NEVER flags a translation whose width is within the allowance", () => {
    const random = makeRandom(0x1234_5678);
    for (let i = 0; i < 5000; i += 1) {
      const role = pick(random, ALL_ROLES);
      const profile = pick(random, PROFILES);
      const source = randomString(random, 24);
      const target = randomString(random, 32);
      const fit = evaluateFit(source, target, role, profile);
      if (fit.targetWidth <= fit.allowedWidth) {
        expect(
          fit.verdict,
          `${role}/${profile.code}: ${JSON.stringify(target)} at ${fit.targetWidth}em <= ${fit.allowedWidth}em was not "fits"`,
        ).toBe("fits");
        expect(fit.overBy).toBe(0);
      } else {
        expect(fit.verdict).not.toBe("fits");
        expect(fit.overBy).toBeGreaterThan(0);
      }
    }
  });

  it("always accepts the source itself as its own translation", () => {
    const random = makeRandom(0xfeed);
    for (let i = 0; i < 1500; i += 1) {
      const role = pick(random, ALL_ROLES);
      const profile = pick(random, PROFILES);
      const source = randomString(random, 30);
      expect(evaluateFit(source, source, role, profile).verdict).toBe("fits");
    }
  });

  it("is monotonic: a shorter translation is never a worse verdict", () => {
    const rank = { fits: 0, tight: 1, overflow: 2 } as const;
    const random = makeRandom(0x99);
    for (let i = 0; i < 1500; i += 1) {
      const role = pick(random, ALL_ROLES);
      const profile = pick(random, PROFILES);
      const source = randomString(random, 16);
      const target = randomString(random, 24);
      if (target.length === 0) continue;
      const shorter = [...target].slice(0, -1).join("");
      expect(
        rank[evaluateFit(source, shorter, role, profile).verdict],
      ).toBeLessThanOrEqual(rank[evaluateFit(source, target, role, profile).verdict]);
    }
  });

  it("reports overBy in the target's own character units", () => {
    // 3 extra Japanese glyphs (5.85em) must not be reported as ~11 characters.
    const fit = evaluateFit("Go", "設定画面を開きます", "button", ja);
    expect(fit.verdict).toBe("overflow");
    const excess = fit.targetWidth - fit.allowedWidth;
    expect(fit.overBy).toBeCloseTo(Math.ceil(excess / ja.glyphWidth), 0);
    // The same excess in German is far more characters.
    const german = evaluateFit("Go", "Einstellungen jetzt öffnen", "button", de);
    expect(german.overBy).toBeGreaterThan(fit.overBy);
  });
});

describe("evaluateFit — multi-line body copy", () => {
  it("compares the widest line, not the total advance", () => {
    const source = "The quick brown fox jumps over the lazy dog every day.";
    const wrapped = `${source}\n${source}`;
    const flat = evaluateFit(source, source, "body", de);
    const multi = evaluateFit(source, wrapped, "body", de);
    expect(multi.targetWidth).toBe(flat.targetWidth);
    expect(multi.verdict).toBe("fits");
  });

  it("measures a multi-line source by its widest line too", () => {
    const fit = evaluateFit("Hi\nA considerably longer line", "Hallo", "body", de);
    expect(fit.sourceWidth).toBe(
      estimateLongestLineWidth("A considerably longer line", de),
    );
  });

  it("still flags a single over-long line inside a multi-line block", () => {
    const source = "Short line\nShort line";
    const target = `Short line\n${"sehr ".repeat(30)}`;
    expect(evaluateFit(source, target, "body", de).verdict).toBe("overflow");
  });
});

describe("describeFitForRepair", () => {
  it("quantifies the miss", () => {
    const fit = evaluateFit("OK", "Bestätigen", "button", de);
    const text = describeFitForRepair(fit, de);
    expect(text).toContain("em against a limit of");
    expect(text).toMatch(/Cut at least \d+ more characters?\./);
    expect(text).toContain("Stay at or under");
    expect(text).toContain("placeholder");
  });

  it("mentions glyph width for CJK", () => {
    const fit = evaluateFit("OK", "キャンセルする", "button", ja);
    expect(describeFitForRepair(fit, ja)).toContain("1.95x the width");
  });

  it("says nothing alarming when the string fits", () => {
    const fit = evaluateFit("Save", "Speichern", "button", de);
    expect(describeFitForRepair(fit, de)).toBe(
      "The previous translation fitted its budget.",
    );
  });
});

describe("truncateToWidth — structural enforcement", () => {
  it("leaves strings that already fit untouched", () => {
    const result = truncateToWidth("Speichern", 20, de);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("Speichern");
  });

  it("always returns a string within the budget (property)", () => {
    const random = makeRandom(0xabc123);
    for (let i = 0; i < 3000; i += 1) {
      const profile = pick(random, PROFILES);
      const text = randomString(random, 40);
      const budget = random() * 8;
      const result = truncateToWidth(text, budget, profile);
      expect(
        estimateLongestLineWidth(result.text, profile),
        `${JSON.stringify(text)} clipped to ${budget}em produced ${JSON.stringify(result.text)}`,
      ).toBeLessThanOrEqual(budget);
      expect(result.width).toBe(estimateLongestLineWidth(result.text, profile));
    }
  });

  it("never splits a surrogate pair", () => {
    const random = makeRandom(5);
    for (let i = 0; i < 500; i += 1) {
      const text = randomString(random, 12, ["😀", "漢", "a", "😀😀"]);
      const result = truncateToWidth(text, random() * 6, de);
      expect(result.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(result.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });

  it("never separates a combining mark from its base", () => {
    const text = "e\u0301e\u0301e\u0301e\u0301";
    for (const budget of [0.9, 1.2, 1.6, 2.1, 2.7]) {
      const result = truncateToWidth(text, budget, de, { ellipsis: "" });
      // Every combining acute must still be preceded by its base letter.
      expect(/(^|[^e])\u0301/.test(result.text)).toBe(false);
    }
  });

  it("breaks on a word boundary where the script has one", () => {
    const result = truncateToWidth("Alle Änderungen speichern", 6, de);
    expect(result.text).toBe("Alle…");
  });

  it("does not look for word boundaries in space-less scripts", () => {
    const result = truncateToWidth("設定を保存する", 5, ja);
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith("…")).toBe(true);
    expect(result.text.length).toBeGreaterThan(1);
  });

  it("never cuts inside a preserved placeholder", () => {
    const result = truncateToWidth(
      "Willkommen zurück, {name}, schön dich zu sehen",
      13,
      de,
      { preserve: ["{name}"] },
    );
    expect(result.text).not.toMatch(/\{n?a?m?e?$/);
    expect(result.text.includes("{") ? result.text.includes("{name}") : true).toBe(
      true,
    );
  });

  it("never cuts inside a preserved span that contains a space", () => {
    // `{name}` has no internal space, so it cannot catch this: the
    // word-boundary retreat can only walk a cut back into a span when the span
    // has a space to walk to. Every shape below does, and each is a syntax
    // `lib/types.ts` declares as a `PlaceholderKind`.
    //
    // `sentinel` is a character that occurs nowhere in the text except inside
    // the span. Truncation only ever emits a prefix of the input, so any
    // surviving fragment of the span is a prefix of it and therefore contains
    // the sentinel — which makes "sentinel present without the whole span" an
    // exact detector for a split placeholder.
    const cases: Array<{ text: string; span: string; sentinel: string }> = [
      { text: "Go {{ user }} now", span: "{{ user }}", sentinel: "{" },
      {
        text: "Hi {count, plural, one {#} other {#}} left",
        span: "{count, plural, one {#} other {#}}",
        sentinel: "{",
      },
      {
        text: "Hallo %(user name)s, willkommen",
        span: "%(user name)s",
        sentinel: "%",
      },
      {
        text: 'Open <b class="x">now please',
        span: '<b class="x">',
        sentinel: "<",
      },
    ];

    for (const { text, span, sentinel } of cases) {
      expect(text.split(sentinel).length - 1).toBe(
        span.split(sentinel).length - 1,
      );

      // Sweep the whole budget range: the bug only shows at the budgets where
      // the natural cut happens to land at or inside the span, a narrow window
      // that a single hand-picked width misses.
      const full = estimateLongestLineWidth(text, de);
      for (let step = 2; step <= Math.ceil(full * 10) + 5; step += 1) {
        const budget = step / 10;
        const result = truncateToWidth(text, budget, de, { preserve: [span] });
        const label = `budget=${budget.toFixed(1)} -> ${JSON.stringify(result.text)}`;
        if (result.text.includes(sentinel)) {
          expect(result.text.includes(span), label).toBe(true);
        }
        expect(result.width, label).toBeLessThanOrEqual(budget);
      }
    }
  });

  it("keeps retreating when escaping one span lands inside another", () => {
    // Overlapping spans: retreating to the start of "cd ef" lands inside
    // "ab cd", which the loop had already passed. One pass stops at offset 6
    // and emits "xx ab…" — half of a preserved span.
    const result = truncateToWidth("xx ab cd ef yy", 5.05, de, {
      preserve: ["ab cd", "cd ef"],
    });
    expect(result.text).toBe("xx…");
  });

  it("supports a hard clip with no ellipsis", () => {
    const result = truncateToWidth("Speichern", 2, de, { ellipsis: "" });
    expect(result.text.endsWith("…")).toBe(false);
    expect(estimateLongestLineWidth(result.text, de)).toBeLessThanOrEqual(2);
  });

  it("returns an empty string when not even an ellipsis fits", () => {
    expect(truncateToWidth("Speichern", 0.1, de).text).toBe("");
    expect(truncateToWidth("Speichern", 0, de).text).toBe("");
  });
});

describe("enforceFit", () => {
  it("makes overflow unrepresentable in the output", () => {
    const random = makeRandom(0x7777);
    for (let i = 0; i < 1500; i += 1) {
      const role = pick(random, ALL_ROLES);
      const profile = pick(random, PROFILES);
      const source = randomString(random, 20);
      const target = randomString(random, 60);
      const clipped = enforceFit(source, target, role, profile);
      const fit = evaluateFit(source, clipped.text, role, profile);
      expect(
        fit.verdict,
        `${role}/${profile.code}: ${JSON.stringify(target)} -> ${JSON.stringify(clipped.text)}`,
      ).toBe("fits");
    }
  });

  it("is a no-op for translations that already fit", () => {
    const result = enforceFit("Save", "Speichern", "button", de);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("Speichern");
  });
});

describe("budgetFor", () => {
  it("mirrors budgetForRole", () => {
    expect(budgetFor("Save", "button", de)).toEqual(
      budgetForRole("button", "Save", de),
    );
  });
});
