import { describe, expect, it } from "vitest";

import { getLocaleProfile } from "@/lib/layout";
import type { GlossaryTerm } from "@/lib/types";
import {
  buildSystemPrompt,
  buildUserPrompt,
  lookupGlossaryTarget,
  resolveGlossary,
  toneSpec,
} from "./prompt";
import { makeRequest, makeUnit } from "./testing";

describe("buildSystemPrompt", () => {
  it("frames the role and names both the source and the target locale", () => {
    const prompt = buildSystemPrompt(
      makeRequest({ locale: "de", units: [makeUnit({ key: "a", source: "Save" })] }),
    );

    expect(prompt).toMatch(/senior localisation engineer/i);
    expect(prompt).toMatch(/indie games and developer tools/i);
    expect(prompt).toContain("German (Deutsch)");
    expect(prompt).toContain("from en into");
  });

  it("reproduces the product context verbatim", () => {
    const context =
      "Neon Drifter — a 1980s synthwave roguelike deckbuilder. The player is 'the Drifter'.";
    const prompt = buildSystemPrompt(
      makeRequest({
        productContext: context,
        units: [makeUnit({ key: "a", source: "Play" })],
      }),
    );
    expect(prompt).toContain(context);
  });

  it("copes with an empty product context without leaving a hole", () => {
    const prompt = buildSystemPrompt(
      makeRequest({
        productContext: "   ",
        units: [makeUnit({ key: "a", source: "Play" })],
      }),
    );
    expect(prompt).toMatch(/did not describe the product/i);
  });

  describe("tone", () => {
    it("licenses slang and forbids corporate flattening for gaming", () => {
      const prompt = buildSystemPrompt(
        makeRequest({
          tone: "gaming",
          units: [makeUnit({ key: "hud.dead", source: "You died!" })],
        }),
      );

      expect(prompt).toMatch(/slang/i);
      expect(prompt).toMatch(/contraction/i);
      expect(prompt).toMatch(/community/i);
      expect(prompt).toMatch(/FORBIDDEN: corporate-neutral flattening/);
      expect(prompt).toMatch(/informal second person/i);
    });

    it("names loanword retention and gives the German dev example for technical-developer", () => {
      const prompt = buildSystemPrompt(
        makeRequest({
          tone: "technical-developer",
          units: [makeUnit({ key: "git.branch", source: "Branch" })],
        }),
      );

      expect(prompt).toContain("LOANWORD RETENTION");
      expect(prompt).toContain('"Branch"');
      expect(prompt).toContain('"Zweig"');
      expect(prompt).toContain('"Commit"');
      expect(prompt).toContain('"Übergabe"');
      expect(prompt).toMatch(/usage, not availability/i);
    });

    it("carries a distinct register block for every tone", () => {
      const tones = [
        "neutral-product",
        "casual-indie",
        "gaming",
        "technical-developer",
        "formal-enterprise",
      ] as const;

      const summaries = new Set<string>();
      for (const tone of tones) {
        const spec = toneSpec(tone);
        expect(spec.rules.length).toBeGreaterThan(0);
        summaries.add(spec.summary);

        const prompt = buildSystemPrompt(
          makeRequest({ tone, units: [makeUnit({ key: "a", source: "Save" })] }),
        );
        expect(prompt).toContain(spec.label);
        expect(prompt).toContain(spec.summary);
      }
      expect(summaries.size).toBe(tones.length);
    });

    it("demands the formal second person for formal-enterprise", () => {
      const prompt = buildSystemPrompt(
        makeRequest({
          tone: "formal-enterprise",
          units: [makeUnit({ key: "a", source: "Save" })],
        }),
      );
      expect(prompt).toMatch(/formal second person/i);
      expect(prompt).toContain("Sie / vous / usted");
    });
  });

  describe("length discipline", () => {
    const prompt = buildSystemPrompt(
      makeRequest({ locale: "de", units: [makeUnit({ key: "a", source: "Save" })] }),
    );

    it("explains the hard budget and why exceeding it breaks the product", () => {
      expect(prompt).toMatch(/character budget/i);
      expect(prompt).toMatch(/fixed-width chrome/i);
      expect(prompt).toMatch(/clips, overlaps its neighbour, or reflows/i);
    });

    it("prefers a shorter natural equivalent over an accurate long one", () => {
      expect(prompt).toMatch(
        /SHORTER natural equivalent always beats a longer accurate one/i,
      );
      expect(prompt).toMatch(/idiomatic in this locale's UIs/i);
    });

    it("forbids mid-word truncation and forced ellipses", () => {
      expect(prompt).toContain("NEVER truncate mid-word");
      expect(prompt).toMatch(/NEVER add an ellipsis/);
    });

    it("quantifies the locale's expansion", () => {
      expect(prompt).toContain("135%");
    });

    it("warns that CJK glyphs are wide even though there are fewer of them", () => {
      const ja = buildSystemPrompt(
        makeRequest({ locale: "ja", units: [makeUnit({ key: "a", source: "Save", locale: "ja" })] }),
      );
      expect(ja).toMatch(/fewer characters does not mean a narrower string/i);
    });
  });

  describe("placeholder discipline", () => {
    it("demands exact reproduction and allows reordering only", () => {
      const prompt = buildSystemPrompt(
        makeRequest({
          units: [makeUnit({ key: "a", source: "Hello {name}, you have {count} items" })],
        }),
      );

      expect(prompt).toMatch(/EXACTLY, character for character/);
      expect(prompt).toMatch(/You MAY move a placeholder/);
      expect(prompt).toMatch(/may NOT translate it, rename it, re-space it/);
      expect(prompt).toContain("ICU / named brace");
    });

    it("only documents the placeholder kinds present in the batch", () => {
      const prompt = buildSystemPrompt(
        makeRequest({ units: [makeUnit({ key: "a", source: "Hi {{user}}" })] }),
      );
      expect(prompt).toContain("mustache / i18next");
      expect(prompt).not.toContain("Python-style named interpolation");
    });

    it("flags bare printf order as load-bearing", () => {
      const prompt = buildSystemPrompt(
        makeRequest({ units: [makeUnit({ key: "a", source: "%s of %s" })] }),
      );
      expect(prompt).toContain("ORDER IS LOAD-BEARING");
      expect(prompt).toMatch(/exactly the source order/i);
    });

    it("adds bidi guidance for RTL locales only", () => {
      const rtl = buildSystemPrompt(
        makeRequest({
          locale: "ar",
          units: [makeUnit({ key: "a", source: "Hello {name}", locale: "ar" })],
        }),
      );
      const ltr = buildSystemPrompt(
        makeRequest({ units: [makeUnit({ key: "a", source: "Hello {name}" })] }),
      );
      expect(rtl).toContain("U+2066");
      expect(ltr).not.toContain("U+2066");
    });
  });

  describe("ambiguity discipline", () => {
    const prompt = buildSystemPrompt(
      makeRequest({ units: [makeUnit({ key: "a", source: "Run" })] }),
    );

    it("makes disambiguation notes authoritative", () => {
      expect(prompt).toMatch(
        /notes are authoritative and override your own default reading/i,
      );
    });

    it("teaches resolution by UI role for the canonical ambiguous words", () => {
      for (const word of ["Run", "Save", "Load", "Right", "min", "Free", "Match", "Sign"]) {
        expect(prompt).toContain(`"${word}"`);
      }
      expect(prompt).toMatch(/Resolve by UI ROLE first/);
    });
  });

  describe("glossary", () => {
    const glossary: GlossaryTerm[] = [
      {
        term: "Drift Points",
        translations: { de: "Drift-Punkte" },
        caseSensitive: true,
        note: "In-game currency.",
      },
      { term: "Neon Drifter", translations: {}, caseSensitive: false },
    ];

    it("lists forced renderings and verbatim terms separately", () => {
      const prompt = buildSystemPrompt(
        makeRequest({ locale: "de", glossary, units: [makeUnit({ key: "a", source: "Save" })] }),
      );
      expect(prompt).toContain('"Drift Points" → "Drift-Punkte"');
      expect(prompt).toContain("[case-sensitive]");
      expect(prompt).toContain("In-game currency.");
      expect(prompt).toMatch(/KEEP THEM VERBATIM IN ENGLISH/);
      expect(prompt).toContain('"Neon Drifter"');
    });

    it("falls back to the base language for a regional locale", () => {
      const term = glossary[0]!;
      expect(lookupGlossaryTarget(term, "de-CH")).toBe("Drift-Punkte");
      expect(lookupGlossaryTarget(term, "fr")).toBeNull();
    });

    it("treats a locale with no entry as verbatim", () => {
      const lines = resolveGlossary(glossary, getLocaleProfile("ja"));
      expect(lines.every((line) => line.target === null)).toBe(true);
    });

    it("still demands internal consistency when no glossary is supplied", () => {
      const prompt = buildSystemPrompt(
        makeRequest({ units: [makeUnit({ key: "a", source: "Save" })] }),
      );
      expect(prompt).toMatch(/terminology internally consistent/i);
    });
  });

  describe("output contract", () => {
    const prompt = buildSystemPrompt(
      makeRequest({ units: [makeUnit({ key: "a", source: "Save" })] }),
    );

    it("specifies the exact JSON envelope", () => {
      expect(prompt).toContain('{"translations":[{"key":');
      expect(prompt).toContain('"target"');
      expect(prompt).toContain('"rationale"');
    });

    it("bans fences and prose and constrains the rationale", () => {
      expect(prompt).toMatch(/No markdown fences\. No prose/);
      expect(prompt).toMatch(/ONE short clause, in ENGLISH/);
      expect(prompt).toMatch(/OMIT the field entirely when the choice is obvious/);
    });
  });

  it("is deterministic for a given request", () => {
    const request = makeRequest({
      units: [makeUnit({ key: "a", source: "Save" }), makeUnit({ key: "b", source: "Cancel" })],
    });
    expect(buildSystemPrompt(request)).toBe(buildSystemPrompt(request));
  });
});

describe("buildUserPrompt", () => {
  it("serialises key, source, role, budget, placeholders, notes and neighbours", () => {
    const unit = makeUnit({
      key: "menu.file.save",
      source: "Save {count} files",
      role: "menu",
      neighbors: ["menu.file.open", "menu.file.close"],
      developerNote: "Appears in the File menu.",
      ambiguities: [
        {
          kind: "action-or-state",
          note: '"Save" here is the action, not the "Saving…" state.',
          confidence: 0.8,
        },
      ],
    });
    const prompt = buildUserPrompt(makeRequest({ units: [unit] }));

    expect(prompt).toContain("key: menu.file.save");
    expect(prompt).toContain('source: "Save {count} files"');
    expect(prompt).toContain("role: menu —");
    expect(prompt).toMatch(/length: Maximum \d+ characters/);
    expect(prompt).toContain("{count} (icu, arg \"count\")");
    expect(prompt).toContain("[action-or-state, confidence 0.80]");
    expect(prompt).toContain("developer note: Appears in the File menu.");
    expect(prompt).toContain("sibling keys: menu.file.open, menu.file.close");
  });

  it("says 'none' rather than leaving fields blank", () => {
    const prompt = buildUserPrompt(
      makeRequest({ units: [makeUnit({ key: "a", source: "Save" })] }),
    );
    expect(prompt).toContain("placeholders: none");
    expect(prompt).toContain("ambiguity notes: none");
    expect(prompt).toContain("sibling keys: none");
  });

  it("lists placeholders in source order", () => {
    const prompt = buildUserPrompt(
      makeRequest({ units: [makeUnit({ key: "a", source: "{b} then {a}" })] }),
    );
    expect(prompt.indexOf("{b}")).toBeLessThan(prompt.indexOf("{a}"));
  });

  it("caps neighbour lists so context does not become noise", () => {
    const neighbors = Array.from({ length: 20 }, (_, i) => `k${i}`);
    const prompt = buildUserPrompt(
      makeRequest({ units: [makeUnit({ key: "a", source: "Save", neighbors })] }),
    );
    expect(prompt).toContain("(+12 more)");
  });

  describe("repair passes", () => {
    const unit = makeUnit({
      key: "buttons.save",
      source: "Save",
      previousAttempt: "Änderungen dauerhaft speichern",
      repairFeedback: "It renders at 14.20em against a limit of 6.10em. Cut at least 12 characters.",
    });
    const prompt = buildUserPrompt(makeRequest({ units: [unit] }));

    it("is visually distinct from a first pass", () => {
      expect(prompt).toContain("!! REPAIR PASS");
      expect(prompt).toMatch(/REPAIR PASSES: 1 of the 1 units/);
    });

    it("states plainly what was wrong and what must change", () => {
      expect(prompt).toContain('REJECTED PREVIOUS ATTEMPT: "Änderungen dauerhaft speichern"');
      expect(prompt).toContain("WHY IT WAS REJECTED: It renders at 14.20em");
      expect(prompt).toContain("REQUIRED: return a DIFFERENT string");
      expect(prompt).toMatch(/Do not truncate it or bolt an ellipsis/);
    });

    it("leaves first-pass units unmarked", () => {
      const mixed = buildUserPrompt(
        makeRequest({ units: [makeUnit({ key: "clean", source: "Cancel" }), unit] }),
      );
      const first = mixed.slice(mixed.indexOf("UNIT 1/2"), mixed.indexOf("UNIT 2/2"));
      expect(first).not.toContain("REPAIR PASS");
    });
  });

  it("numbers units and closes with the entry-count instruction", () => {
    const prompt = buildUserPrompt(
      makeRequest({
        units: [makeUnit({ key: "a", source: "A" }), makeUnit({ key: "b", source: "B" })],
      }),
    );
    expect(prompt).toContain("UNIT 1/2");
    expect(prompt).toContain("UNIT 2/2");
    expect(prompt).toContain("exactly 2 entries");
    expect(prompt).toContain("no markdown fences");
  });

  it("JSON-encodes sources so newlines and quotes are unambiguous", () => {
    const prompt = buildUserPrompt(
      makeRequest({
        units: [makeUnit({ key: "a", source: 'Line one\nSay "hi"', role: "body" })],
      }),
    );
    expect(prompt).toContain('source: "Line one\\nSay \\"hi\\""');
  });
});
