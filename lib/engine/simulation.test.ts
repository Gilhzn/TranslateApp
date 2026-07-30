import { describe, expect, it } from "vitest";

import { extractPlaceholders } from "@/lib/core";
import {
  describeFitForRepair,
  estimateLongestLineWidth,
  evaluateFit,
  getLocaleProfile,
} from "@/lib/layout";
import type { GlossaryTerm, LocaleCode, UiRole } from "@/lib/types";
import { resolveGlossary } from "./prompt";
import {
  DeterministicProvider,
  applyGlossary,
  hash32,
  simulateTranslation,
  splitOnPlaceholders,
  type SimulationContext,
} from "./simulation";
import { makeRequest, makeUnit } from "./testing";

function contextFor(
  locale: LocaleCode,
  glossary: GlossaryTerm[] = [],
  seed = "lingoloop",
): SimulationContext {
  const profile = getLocaleProfile(locale);
  return { profile, glossary: resolveGlossary(glossary, profile), seed };
}

function translate(
  locale: LocaleCode,
  key: string,
  source: string,
  role: UiRole = "button",
  glossary: GlossaryTerm[] = [],
): string {
  const profile = getLocaleProfile(locale);
  return simulateTranslation(
    makeUnit({ key, source, role, locale: profile }),
    contextFor(locale, glossary),
  ).target;
}

/** Every placeholder from the source, present exactly once and in order. */
function expectPlaceholderParity(source: string, target: string): void {
  const raws = extractPlaceholders(source).map((placeholder) => placeholder.raw);
  let cursor = 0;
  for (const raw of raws) {
    const at = target.indexOf(raw, cursor);
    expect(at, `${raw} missing or out of order in ${JSON.stringify(target)}`).toBeGreaterThanOrEqual(0);
    cursor = at + raw.length;
  }
  for (const raw of new Set(raws)) {
    const expected = raws.filter((candidate) => candidate === raw).length;
    expect(target.split(raw).length - 1).toBe(expected);
  }
}

describe("hash32", () => {
  it("is stable and well distributed enough to index a small pool", () => {
    expect(hash32("a")).toBe(hash32("a"));
    expect(hash32("a")).not.toBe(hash32("b"));
    const spread = new Set(
      Array.from({ length: 200 }, (_, i) => hash32(`key-${i}`) % 20),
    );
    expect(spread.size).toBeGreaterThan(10);
  });
});

describe("splitOnPlaceholders", () => {
  it("keeps placeholders as immutable segments in source order", () => {
    const source = "Hi {name}, {count} left";
    expect(splitOnPlaceholders(source, extractPlaceholders(source))).toEqual([
      { kind: "text", text: "Hi " },
      { kind: "immutable", text: "{name}" },
      { kind: "text", text: ", " },
      { kind: "immutable", text: "{count}" },
      { kind: "text", text: " left" },
    ]);
  });

  it("recovers when the recorded index is stale", () => {
    const source = "Hi {name}";
    const placeholders = extractPlaceholders(source).map((placeholder) => ({
      ...placeholder,
      index: 999,
    }));
    const segments = splitOnPlaceholders(source, placeholders);
    expect(segments).toContainEqual({ kind: "immutable", text: "{name}" });
  });

  it("skips a placeholder that is not in the string rather than guessing", () => {
    const segments = splitOnPlaceholders("plain text", [
      { raw: "{ghost}", kind: "icu", token: "ghost", index: 3 },
    ]);
    expect(segments).toEqual([{ kind: "text", text: "plain text" }]);
  });
});

describe("applyGlossary", () => {
  const lines = [
    { term: "Drift Points", target: "Drift-Punkte", caseSensitive: false },
    { term: "Drift", target: "Drift", caseSensitive: false },
  ];

  it("prefers the longest match at a position", () => {
    expect(applyGlossary("Earn Drift Points now", lines)).toEqual([
      { kind: "text", text: "Earn " },
      { kind: "immutable", text: "Drift-Punkte" },
      { kind: "text", text: " now" },
    ]);
  });

  it("matches whole words only", () => {
    expect(applyGlossary("Drifting away", lines)).toEqual([
      { kind: "text", text: "Drifting away" },
    ]);
  });

  it("honours case sensitivity", () => {
    const strict = [{ term: "Build", target: "Build", caseSensitive: true }];
    expect(applyGlossary("build it", strict)).toEqual([
      { kind: "text", text: "build it" },
    ]);
    expect(applyGlossary("Build it", strict)).toContainEqual({
      kind: "immutable",
      text: "Build",
    });
  });
});

describe("simulateTranslation", () => {
  describe("determinism", () => {
    it("returns identical output for identical input", () => {
      expect(translate("de", "a.b", "Save changes")).toBe(
        translate("de", "a.b", "Save changes"),
      );
    });

    it("varies by key, by locale and by seed", () => {
      const base = translate("de", "a.b", "Save changes");
      expect(translate("de", "a.c", "Save changes")).not.toBe(base);
      expect(translate("fr", "a.b", "Save changes")).not.toBe(base);

      const unit = makeUnit({ key: "a.b", source: "Save changes", locale: "de" });
      const other = simulateTranslation(unit, contextFor("de", [], "other-seed")).target;
      expect(other).not.toBe(base);
    });
  });

  describe("placeholder parity", () => {
    const cases: Array<[string, string]> = [
      ["icu", "Hello {name}, you have {count} messages"],
      ["printf", "Copied %s of %s files"],
      ["indexed printf", "Moved %1$s to %2$s"],
      ["mustache", "Welcome back, {{user}}!"],
      ["dollar-brace", "Deploying ${branch} to ${env}"],
      ["percent-named", "Hi %(first)s %(last)s"],
      ["angle tags", "Read the <b>manual</b> before <i>starting</i>"],
      ["indexed brace", "Round {0} of {1}"],
      ["i18next nesting", "See $t(common.help) for details"],
    ];

    for (const [label, source] of cases) {
      it(`reproduces ${label} exactly and in order`, () => {
        const target = translate("de", `k.${label}`, source, "body");
        expectPlaceholderParity(source, target);
      });
    }

    it("keeps parity across every catalogued script", () => {
      const source = "Hello {name}, you have %d new messages";
      for (const locale of ["de", "fr", "ru", "ja", "ko", "zh", "ar", "he", "th", "hi", "el"]) {
        expectPlaceholderParity(source, translate(locale, "k.x", source, "body"));
      }
    });

    it("keeps parity through a repair pass", () => {
      const profile = getLocaleProfile("de");
      const source = "Deleted {count} items from {name}";
      const first = translate("de", "toast.deleted", source, "toast");
      const repaired = simulateTranslation(
        makeUnit({
          key: "toast.deleted",
          source,
          role: "toast",
          locale: profile,
          previousAttempt: first,
          repairFeedback: "Too long. Cut at least 6 characters.",
        }),
        contextFor("de"),
      ).target;
      expectPlaceholderParity(source, repaired);
      expect(repaired).not.toBe(first);
    });
  });

  describe("do-not-translate passthrough", () => {
    it.each([
      ["https://example.com/docs", "url"],
      ["#FF00AA", "hex colour"],
      ["1.4.2", "semver"],
      ["{{first}} {{last}}", "placeholder only"],
      ["assets/ui/icon.png", "path"],
      ["   ", "blank"],
    ])("passes %s through verbatim (%s)", (source) => {
      const unit = makeUnit({ key: "k.x", source, role: "label", locale: "de" });
      const result = simulateTranslation(unit, contextFor("de"));
      expect(result.target).toBe(source);
      expect(result.rationale).toMatch(/not human copy/);
    });
  });

  describe("glossary", () => {
    const glossary: GlossaryTerm[] = [
      { term: "Drift Points", translations: { de: "Drift-Punkte" }, caseSensitive: false },
      { term: "Neon Drifter", translations: {}, caseSensitive: false },
    ];

    it("applies the forced rendering for the locale", () => {
      const target = translate("de", "hud.currency", "Spend Drift Points", "label", glossary);
      expect(target).toContain("Drift-Punkte");
    });

    it("keeps a term with no locale entry verbatim in English", () => {
      const target = translate("de", "hud.title", "Neon Drifter beta", "title", glossary);
      expect(target).toContain("Neon Drifter");
    });

    it("does not pseudo-localise inside a glossary term", () => {
      const target = translate("ru", "hud.title", "Neon Drifter", "title", glossary);
      expect(target).toBe("Neon Drifter");
    });
  });

  describe("target scripts", () => {
    const expectations: Array<[LocaleCode, RegExp]> = [
      ["de", /[äöüÄÖÜß]/u],
      ["ru", /[Ѐ-ӿ]/u],
      ["ja", /[぀-ヿ]/u],
      ["ko", /[가-힯]/u],
      ["zh", /[一-鿿]/u],
      ["ar", /[؀-ۿ]/u],
      ["he", /[֐-׿]/u],
      ["th", /[฀-๿]/u],
      ["el", /[Ͱ-Ͽ]/u],
      ["hi", /[ऀ-ॿ]/u],
    ];

    for (const [locale, pattern] of expectations) {
      it(`renders ${locale} in its own script`, () => {
        const target = translate(locale, "menu.settings", "Open settings menu", "menu");
        expect(target).toMatch(pattern);
        expect(target).not.toBe("Open settings menu");
      });
    }

    it("falls back to accented Latin for an unknown locale", () => {
      const target = translate("xx-YY", "menu.settings", "Settings", "menu");
      expect(target).toMatch(/[\p{Script=Latin}]/u);
    });

    it("adds no bidi control characters to RTL output", () => {
      const target = translate("ar", "toast.done", "Saved {count} files", "toast");
      expect(target).not.toMatch(/[‎‏⁦-⁩]/u);
    });

    it("does not insert word spaces in scripts that have none", () => {
      for (const locale of ["ja", "zh", "th"]) {
        const target = translate(locale, "menu.settings", "Open settings menu", "menu");
        expect(target).not.toMatch(/\s/u);
      }
    });

    it("keeps eojeol spacing in Korean, which does have word breaks", () => {
      expect(translate("ko", "menu.settings", "Open settings menu", "menu")).toMatch(/\s/u);
    });
  });

  describe("casing", () => {
    it("mirrors an all-caps source", () => {
      expect(translate("de", "badge.new", "NEW", "badge")).toMatch(/^[^a-z]+$/u);
    });

    it("mirrors a capitalised source", () => {
      const target = translate("de", "button.save", "Save", "button");
      expect(target.charAt(0)).toBe(target.charAt(0).toUpperCase());
    });

    it("leaves lowercase sources lowercase", () => {
      const target = translate("de", "label.username", "username", "label");
      expect(target).toBe(target.toLowerCase());
    });
  });

  describe("layout pressure", () => {
    it("produces genuine overflow so the repair loop has work to do", () => {
      const sources: Array<[string, UiRole]> = [
        ["Save changes", "button"],
        ["Export project", "button"],
        ["Confirm deletion", "button"],
        ["Open settings menu", "menu"],
        ["Notifications", "menu"],
        ["Restore defaults", "button"],
      ];

      const verdicts = sources.map(([source, role]) => {
        const profile = getLocaleProfile("de");
        const target = translate("de", `k.${source}`, source, role);
        return evaluateFit(source, target, role, profile).verdict;
      });

      expect(verdicts).toContain("overflow");
      // …but not everything: a simulator that overflows unconditionally would
      // exercise nothing except the repair loop.
      expect(verdicts.some((verdict) => verdict !== "overflow")).toBe(true);
    });
  });

  describe("repair", () => {
    it("returns a strictly narrower string than the rejected attempt", () => {
      const profile = getLocaleProfile("de");
      const source = "Open settings menu";
      const first = translate("de", "menu.settings", source, "menu");
      const repaired = simulateTranslation(
        makeUnit({
          key: "menu.settings",
          source,
          role: "menu",
          locale: profile,
          previousAttempt: first,
          repairFeedback: "Too long.",
        }),
        contextFor("de"),
      ).target;

      const before = evaluateFit(source, first, "menu", profile).targetWidth;
      const after = evaluateFit(source, repaired, "menu", profile).targetWidth;
      expect(after).toBeLessThan(before);
      expect(repaired).not.toBe(first);
    });

    it("converges to a fitting string within the repair budget, in every script", () => {
      const cases: Array<[LocaleCode, string, UiRole]> = [
        ["de", "Save changes", "button"],
        ["de", "Open settings menu", "menu"],
        ["ru", "Confirm deletion", "button"],
        ["fi", "Export project", "button"],
        ["ja", "Open settings menu", "menu"],
        ["ko", "Save changes", "button"],
        ["zh", "Save changes", "button"],
        ["ar", "Restore all defaults now", "button"],
      ];

      for (const [locale, source, role] of cases) {
        const profile = getLocaleProfile(locale);
        const context = contextFor(locale);

        let target = simulateTranslation(
          makeUnit({ key: "b.k", source, role, locale: profile }),
          context,
        ).target;
        let fit = evaluateFit(source, target, role, profile);
        const widths = [fit.targetWidth];

        // The real pipeline allows a small number of repairs; so does this.
        for (let attempt = 0; attempt < 3 && fit.verdict !== "fits"; attempt += 1) {
          const previous = target;
          target = simulateTranslation(
            makeUnit({
              key: "b.k",
              source,
              role,
              locale: profile,
              previousAttempt: previous,
              repairFeedback: describeFitForRepair(fit, profile),
            }),
            context,
          ).target;
          fit = evaluateFit(source, target, role, profile);
          widths.push(fit.targetWidth);
        }

        expect(fit.verdict, `${locale} "${source}" never fitted: ${target}`).toBe("fits");
        for (let i = 1; i < widths.length; i += 1) {
          expect(widths[i]!, `${locale} widths ${widths.join(" > ")}`).toBeLessThan(
            widths[i - 1]!,
          );
        }
      }
    });

    // Regression: the convergence test above only ever feeds multi-word sources
    // ("Save changes", "Open settings menu"), where dropping a word still leaves
    // one behind. Real buttons and badges are one short word — they hit the
    // syllable floor on the FIRST repair, and the previous implementation then
    // dropped the only word, returned "", and re-inflated to full width on the
    // next round: a period-2 oscillation that never terminated and handed the
    // pipeline a blank string. Anything that returns from a repair must be
    // non-empty and never wider than what it replaced.
    it("never empties or re-inflates a one-word string across repeated repairs", () => {
      const sources = ["OK", "Go", "Run", "New", "Free", "min", "Off"];
      const roles: UiRole[] = ["button", "badge"];
      const locales: LocaleCode[] = ["de", "ru", "ja", "he"];

      for (const locale of locales) {
        const profile = getLocaleProfile(locale);
        const context = contextFor(locale);

        for (const role of roles) {
          for (const source of sources) {
            const label = `${locale}/${role} ${JSON.stringify(source)}`;
            let target = simulateTranslation(
              makeUnit({ key: "b.k", source, role, locale: profile }),
              context,
            ).target;
            let fit = evaluateFit(source, target, role, profile);
            const chain = [target];

            expect(target.trim().length, `${label} first pass was empty`).toBeGreaterThan(0);

            for (let attempt = 0; attempt < 5; attempt += 1) {
              const previous = target;
              const previousWidth = estimateLongestLineWidth(previous, profile);

              target = simulateTranslation(
                makeUnit({
                  key: "b.k",
                  source,
                  role,
                  locale: profile,
                  previousAttempt: previous,
                  repairFeedback: describeFitForRepair(fit, profile),
                }),
                context,
              ).target;
              fit = evaluateFit(source, target, role, profile);
              chain.push(target);

              const trace = `${label} chain=${chain.map((s) => JSON.stringify(s)).join(" -> ")}`;
              expect(target.trim().length, `${trace} emitted an empty target`).toBeGreaterThan(0);
              expect(
                estimateLongestLineWidth(target, profile),
                `${trace} grew instead of converging`,
              ).toBeLessThanOrEqual(previousWidth);
            }
          }
        }
      }
    });

    // The same two invariants as a property, over the shapes the pipeline
    // actually sees: placeholder-carrying strings, padded strings, punctuation
    // and multi-word copy, in every script family, driven past the point where
    // shrinking stops helping.
    it("holds the non-empty and non-growing invariants for every shape and script", () => {
      const sources = [
        "A",
        "Save",
        "Save changes",
        "Restore all defaults now",
        "Deleted {count} items from {name}",
        "%s of %s",
        "  Save  ",
        "Save/Load",
      ];
      const roles: UiRole[] = ["button", "badge", "menu", "toast", "body"];
      const locales: LocaleCode[] = ["de", "ru", "ja", "he", "ko", "zh", "ar", "th", "fi"];

      for (const locale of locales) {
        const profile = getLocaleProfile(locale);
        const context = contextFor(locale);

        for (const role of roles) {
          for (const source of sources) {
            let target = simulateTranslation(
              makeUnit({ key: "b.k", source, role, locale: profile }),
              context,
            ).target;
            let fit = evaluateFit(source, target, role, profile);

            for (let attempt = 0; attempt < 6; attempt += 1) {
              const previous = target;
              const previousWidth = estimateLongestLineWidth(previous, profile);
              target = simulateTranslation(
                makeUnit({
                  key: "b.k",
                  source,
                  role,
                  locale: profile,
                  previousAttempt: previous,
                  repairFeedback: describeFitForRepair(fit, profile),
                }),
                context,
              ).target;
              fit = evaluateFit(source, target, role, profile);

              const trace = `${locale}/${role} ${JSON.stringify(source)} round ${attempt + 1}: ${JSON.stringify(previous)} -> ${JSON.stringify(target)}`;
              expect(target.trim().length, `${trace} emptied the string`).toBeGreaterThan(0);
              expect(
                estimateLongestLineWidth(target, profile),
                `${trace} grew`,
              ).toBeLessThanOrEqual(previousWidth);
            }
          }
        }
      }
    });

    it("stalls on the previous attempt instead of deleting the last word", () => {
      const profile = getLocaleProfile("de");
      const context = contextFor("de");
      // "OK" renders as a single syllable already, so there is nothing left to
      // shrink: the repair must hand the same string back, not an empty one.
      const first = simulateTranslation(
        makeUnit({ key: "b.ok", source: "OK", role: "button", locale: profile }),
        context,
      ).target;
      const repaired = simulateTranslation(
        makeUnit({
          key: "b.ok",
          source: "OK",
          role: "button",
          locale: profile,
          previousAttempt: first,
          repairFeedback: "Too long. Cut at least 2 characters.",
        }),
        context,
      );
      expect(repaired.target).toBe(first);
      expect(repaired.rationale).not.toMatch(/shortened to fit/);
      expect(repaired.rationale).toMatch(/could not be shortened further/);
    });

    it("never propagates a blank previous attempt back out", () => {
      const result = simulateTranslation(
        makeUnit({
          key: "b.k",
          source: "Save",
          role: "button",
          locale: "de",
          previousAttempt: "",
          repairFeedback: "Previous attempt was empty.",
        }),
        contextFor("de"),
      );
      expect(result.target.trim().length).toBeGreaterThan(0);
    });

    it("labels the repair in its rationale", () => {
      const result = simulateTranslation(
        makeUnit({
          key: "b.k",
          source: "Save",
          role: "button",
          locale: "de",
          previousAttempt: "Speichernnnnn",
          repairFeedback: "Too long.",
        }),
        contextFor("de"),
      );
      expect(result.rationale).toMatch(/shortened to fit the button budget/);
    });

    it("returns the previous attempt when nothing may legally be removed", () => {
      // Placeholder-only content is passthrough, so use a source whose entire
      // text is a glossary term: nothing in it belongs to the simulator.
      const glossary: GlossaryTerm[] = [
        { term: "Neon Drifter", translations: {}, caseSensitive: false },
      ];
      const result = simulateTranslation(
        makeUnit({
          key: "b.k",
          source: "Neon Drifter",
          role: "badge",
          locale: "de",
          previousAttempt: "Neon Drifter",
          repairFeedback: "Too long.",
        }),
        contextFor("de", glossary),
      );
      expect(result.target).toBe("Neon Drifter");
    });
  });
});

describe("DeterministicProvider", () => {
  it("is always configured — it needs no credentials", () => {
    expect(new DeterministicProvider().isConfigured()).toBe(true);
    expect(new DeterministicProvider().id).toBe("deterministic");
  });

  it("answers every unit, once, with the right keys", async () => {
    const request = makeRequest({
      locale: "de",
      units: [
        makeUnit({ key: "menu.save", source: "Save" }),
        makeUnit({ key: "menu.open", source: "Open" }),
        makeUnit({ key: "menu.close", source: "Close" }),
      ],
    });

    const response = await new DeterministicProvider().translate(request);
    expect(response.translations.map((t) => t.key)).toEqual([
      "menu.save",
      "menu.open",
      "menu.close",
    ]);
    expect(response.issues).toEqual([]);
  });

  it("reports no usage, because no tokens were spent", async () => {
    const response = await new DeterministicProvider().translate(
      makeRequest({ units: [makeUnit({ key: "a", source: "Save" })] }),
    );
    expect(response.usage).toBeUndefined();
  });

  it("is stable across provider instances", async () => {
    const request = makeRequest({ units: [makeUnit({ key: "a", source: "Save changes" })] });
    const first = await new DeterministicProvider().translate(request);
    const second = await new DeterministicProvider().translate(request);
    expect(first.translations).toEqual(second.translations);
  });

  it("stops and reports when the signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();

    const response = await new DeterministicProvider().translate(
      makeRequest({ units: [makeUnit({ key: "a", source: "Save" })] }),
      controller.signal,
    );
    expect(response.translations).toEqual([]);
    expect(response.issues[0]?.code).toBe("provider-error");
    expect(response.issues[0]?.message).toMatch(/cancelled/i);
  });

  it("applies the configured latency through the injected sleeper", async () => {
    const slept: number[] = [];
    const provider = new DeterministicProvider({
      latencyMs: 250,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await provider.translate(makeRequest({ units: [makeUnit({ key: "a", source: "Save" })] }));
    expect(slept).toEqual([250]);
  });

  it("handles an empty batch", async () => {
    const response = await new DeterministicProvider().translate(
      makeRequest({ units: [] }),
    );
    expect(response.translations).toEqual([]);
  });
});
