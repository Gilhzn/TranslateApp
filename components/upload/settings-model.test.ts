import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPAIR_ATTEMPTS,
  MAX_REPAIR_ATTEMPTS,
  PRODUCT_CONTEXT_LIMIT,
  TONE_OPTIONS,
  buildTranslationSettings,
  clampRepairAttempts,
  compileGlossary,
  estimateUnits,
  initialSettingsDraft,
  newGlossaryDraft,
  startBlockers,
  toggleLocale,
  type GlossaryDraft,
  type SettingsDraft,
} from "./settings-model";

function draftWith(partial: Partial<SettingsDraft>): SettingsDraft {
  return { ...initialSettingsDraft("en"), ...partial };
}

function term(partial: Partial<GlossaryDraft>): GlossaryDraft {
  return { ...newGlossaryDraft("g1"), ...partial };
}

describe("TONE_OPTIONS", () => {
  it("covers every tone in the contract, with copy from the prompt engine", () => {
    expect(TONE_OPTIONS).toHaveLength(5);
    for (const option of TONE_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.summary.length).toBeGreaterThan(0);
    }
    expect(TONE_OPTIONS.map((option) => option.tone)).toContain("gaming");
  });
});

describe("clampRepairAttempts", () => {
  it("clamps to the supported range", () => {
    expect(clampRepairAttempts(-3)).toBe(0);
    expect(clampRepairAttempts(99)).toBe(MAX_REPAIR_ATTEMPTS);
    expect(clampRepairAttempts(2)).toBe(2);
  });

  it("rounds fractional input and falls back on nonsense", () => {
    expect(clampRepairAttempts(1.6)).toBe(2);
    expect(clampRepairAttempts(Number.NaN)).toBe(DEFAULT_REPAIR_ATTEMPTS);
  });
});

describe("toggleLocale", () => {
  it("appends in selection order and removes on second toggle", () => {
    expect(toggleLocale(["de"], "ja")).toEqual(["de", "ja"]);
    expect(toggleLocale(["de", "ja"], "de")).toEqual(["ja"]);
  });
});

describe("compileGlossary", () => {
  it("drops rows whose term is blank", () => {
    expect(compileGlossary([term({ term: "   " })], ["de"])).toEqual([]);
  });

  it("emits an empty translations map for keep-verbatim terms", () => {
    const [entry] = compileGlossary(
      [term({ term: "Shipyard", keepVerbatim: true, translations: { de: "Werft" } })],
      ["de"],
    );
    expect(entry?.term).toBe("Shipyard");
    // The contract defines {} as "keep verbatim" — the typed-but-disabled
    // rendering must not leak through.
    expect(entry?.translations).toEqual({});
  });

  it("keeps forced renderings only for locales in this job", () => {
    const [entry] = compileGlossary(
      [
        term({
          term: "Deploy",
          keepVerbatim: false,
          translations: { de: "Deploy", ja: "デプロイ", fr: " " },
        }),
      ],
      ["de", "fr"],
    );
    expect(entry?.translations).toEqual({ de: "Deploy" });
  });

  it("dedupes case-insensitively, keeping the first row", () => {
    const compiled = compileGlossary(
      [term({ id: "a", term: "Runner" }), term({ id: "b", term: "runner" })],
      [],
    );
    expect(compiled).toHaveLength(1);
    expect(compiled[0]?.term).toBe("Runner");
  });

  it("carries case sensitivity and omits blank notes", () => {
    const [entry] = compileGlossary(
      [term({ term: "HP", caseSensitive: true, note: "   " })],
      [],
    );
    expect(entry?.caseSensitive).toBe(true);
    expect(entry?.note).toBeUndefined();
  });

  it("keeps a real note", () => {
    const [entry] = compileGlossary([term({ term: "Run", note: "the noun" })], []);
    expect(entry?.note).toBe("the noun");
  });
});

describe("buildTranslationSettings", () => {
  it("produces a complete, contract-shaped settings object", () => {
    const settings = buildTranslationSettings(
      draftWith({
        sourceLocale: "en",
        targetLocales: ["de", "ja"],
        tone: "gaming",
        productContext: "  a roguelike deckbuilder  ",
        enforceLayout: true,
        maxRepairAttempts: 3,
        glossary: [term({ term: "Emberfall" })],
      }),
    );

    expect(settings).toEqual({
      sourceLocale: "en",
      targetLocales: ["de", "ja"],
      tone: "gaming",
      productContext: "a roguelike deckbuilder",
      glossary: [{ term: "Emberfall", translations: {}, caseSensitive: false }],
      enforceLayout: true,
      maxRepairAttempts: 3,
    });
  });

  it("never emits the source locale as a target", () => {
    const settings = buildTranslationSettings(
      draftWith({ sourceLocale: "en", targetLocales: ["de", "en", "de"] }),
    );
    expect(settings.targetLocales).toEqual(["de"]);
  });

  it("truncates over-long product context", () => {
    const settings = buildTranslationSettings(
      draftWith({ productContext: "x".repeat(PRODUCT_CONTEXT_LIMIT + 50) }),
    );
    expect(settings.productContext).toHaveLength(PRODUCT_CONTEXT_LIMIT);
  });

  it("clamps repair attempts on the way out", () => {
    const settings = buildTranslationSettings(draftWith({ maxRepairAttempts: 42 }));
    expect(settings.maxRepairAttempts).toBe(MAX_REPAIR_ATTEMPTS);
  });

  it("scopes glossary renderings to the locales that survived deduping", () => {
    const settings = buildTranslationSettings(
      draftWith({
        sourceLocale: "en",
        targetLocales: ["de", "en"],
        glossary: [
          term({
            term: "Deploy",
            keepVerbatim: false,
            translations: { de: "Deploy", en: "Deploy" },
          }),
        ],
      }),
    );
    expect(settings.glossary[0]?.translations).toEqual({ de: "Deploy" });
  });
});

describe("startBlockers", () => {
  it("asks for a catalog first and stops there", () => {
    const blockers = startBlockers({
      hasCatalog: false,
      translatableKeys: 0,
      targetLocales: [],
    });
    expect(blockers.map((b) => b.code)).toEqual(["no-catalog"]);
  });

  it("flags a catalog with nothing to translate", () => {
    const blockers = startBlockers({
      hasCatalog: true,
      translatableKeys: 0,
      targetLocales: ["de"],
    });
    expect(blockers.map((b) => b.code)).toEqual(["nothing-translatable"]);
  });

  it("flags the empty locale selection", () => {
    const blockers = startBlockers({
      hasCatalog: true,
      translatableKeys: 12,
      targetLocales: [],
    });
    expect(blockers.map((b) => b.code)).toEqual(["no-locales"]);
  });

  it("is empty once the job is runnable", () => {
    expect(
      startBlockers({ hasCatalog: true, translatableKeys: 12, targetLocales: ["de"] }),
    ).toEqual([]);
  });
});

describe("estimateUnits", () => {
  it("multiplies strings by locales", () => {
    expect(estimateUnits(120, ["de", "ja"])).toBe(240);
    expect(estimateUnits(120, [])).toBe(0);
  });
});
