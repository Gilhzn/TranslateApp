import { describe, expect, it } from "vitest";
import type { AmbiguityKind, UiRole } from "@/lib/types";
import { ambiguityTermCount, detectAmbiguities, findWholeWord } from "./ambiguity";

const kindsOf = (key: string, value: string, role: UiRole): AmbiguityKind[] =>
  detectAmbiguities(key, value, role).map((f) => f.kind);

const flagFor = (
  key: string,
  value: string,
  role: UiRole,
  kind: AmbiguityKind,
) => detectAmbiguities(key, value, role).find((f) => f.kind === kind);

describe("findWholeWord", () => {
  it("matches only standalone words", () => {
    expect(findWholeWord("run", "run")).toBe(0);
    expect(findWholeWord("start run now", "run")).toBe(6);
    expect(findWholeWord("runtime", "run")).toBe(-1);
    expect(findWholeWord("rerun", "run")).toBe(-1);
    expect(findWholeWord("re-run", "run")).toBe(3);
  });

  it("handles terms containing punctuation", () => {
    expect(findWholeWord("buy on itch.io today", "itch.io")).toBe(7);
    expect(findWholeWord("co-op mode", "co-op")).toBe(0);
  });
});

describe("detectAmbiguities", () => {
  it("fires verb-or-noun and action-or-state for a bare Save button", () => {
    const flags = detectAmbiguities("buttons.save", "Save", "button");
    const kinds = flags.map((f) => f.kind);
    expect(kinds).toContain("verb-or-noun");
    expect(kinds).toContain("action-or-state");
    for (const flag of flags) expect(flag.confidence).toBeGreaterThan(0.8);
  });

  it("writes actionable, role-aware instructions", () => {
    const flag = flagFor("buttons.save", "Save", "button", "verb-or-noun");
    expect(flag).toBeDefined();
    expect(flag?.note).toContain("'Save'");
    expect(flag?.note).toContain("verb");
    expect(flag?.note.toLowerCase()).toContain("button");
  });

  it("gives noun guidance when the same word labels something", () => {
    const flag = flagFor("plan.savings.label", "Save", "label", "verb-or-noun");
    expect(flag?.note).toContain("noun sense");
  });

  it("drops the flag when the word is safely inside a sentence", () => {
    const sentence =
      "Click Save to keep your changes before you leave this page.";
    expect(kindsOf("body.hint", sentence, "body")).not.toContain(
      "verb-or-noun",
    );
  });

  it("keeps confidence low for a mid-length occurrence", () => {
    const flags = detectAmbiguities("x", "Save your work", "body");
    for (const flag of flags) expect(flag.confidence).toBeLessThan(0.55);
  });

  it("never fires a short term inside a longer word", () => {
    expect(kindsOf("x", "Runtime", "label")).not.toContain("verb-or-noun");
    expect(kindsOf("x", "Runtime", "label")).toContain("tech-term");
    expect(kindsOf("x", "Downloading", "label")).not.toContain(
      "action-or-state",
    );
    expect(kindsOf("x", "Closet", "label")).toEqual([]);
    expect(kindsOf("x", "Bosses", "label")).toEqual([]);
  });

  it("records the original casing in the note", () => {
    const flag = flagFor("x", "SAVE", "button", "verb-or-noun");
    expect(flag?.note).toContain("'SAVE'");
  });

  it("boosts action-or-state under a status key", () => {
    const underStatus = flagFor("status.sync", "Sync", "label", "action-or-state");
    const elsewhere = flagFor("misc.sync", "Sync", "label", "action-or-state");
    expect(underStatus?.confidence ?? 0).toBeGreaterThan(
      elsewhere?.confidence ?? 0,
    );
  });

  it("flags homonyms", () => {
    expect(kindsOf("nav.right", "Right", "menu")).toContain("homonym");
    expect(kindsOf("x", "Free", "badge")).toContain("homonym");
  });

  it("only flags unit abbreviations in numeric context", () => {
    expect(kindsOf("x", "min", "label")).toContain("unit-or-word");
    expect(kindsOf("x", "5 min", "label")).toContain("unit-or-word");
    expect(kindsOf("x", "%d min", "label")).toContain("unit-or-word");
    expect(kindsOf("x", "{count} min", "label")).toContain("unit-or-word");
    expect(kindsOf("x", "No results found", "body")).toEqual([]);
    expect(kindsOf("x", "Sign in to continue", "body")).toEqual([]);
  });

  it("flags brand terms and keeps them confident inside sentences", () => {
    const inSentence = flagFor(
      "footer.social",
      "Join our community on Discord to chat with the developers about the game.",
      "body",
      "brand-term",
    );
    expect(inSentence?.confidence ?? 0).toBeGreaterThan(0.6);
  });

  it("warns that some brands are also ordinary words", () => {
    const flag = flagFor("x", "Steam", "badge", "brand-term");
    expect(flag?.note).toContain("water vapour");
  });

  it("flags gaming slang with register guidance", () => {
    const flag = flagFor("match.end", "GG", "toast", "gaming-slang");
    expect(flag?.note).toContain("good game");
    expect(flag?.note).toContain("register");
    expect(kindsOf("x", "Legendary loot drop", "toast")).toContain(
      "gaming-slang",
    );
  });

  it("flags technical vocabulary", () => {
    expect(kindsOf("x", "Commit", "button")).toContain("tech-term");
    expect(kindsOf("x", "Cache", "label")).toContain("tech-term");
    expect(kindsOf("x", "Rate limit exceeded", "error")).toContain("tech-term");
  });

  it("returns nothing for ordinary copy", () => {
    expect(detectAmbiguities("greeting", "Hello there", "body")).toEqual([]);
    expect(detectAmbiguities("x", "Welcome back!", "heading")).toEqual([]);
  });

  it("returns flags sorted by confidence and bounded in count", () => {
    const noisy =
      "Save Load Run Right Free Commit Cache Build Boss Loot Steam Discord";
    const flags = detectAmbiguities("x", noisy, "label");
    expect(flags.length).toBeLessThanOrEqual(6);
    for (let i = 1; i < flags.length; i++) {
      const previous = flags[i - 1];
      const current = flags[i];
      expect(previous).toBeDefined();
      expect(current).toBeDefined();
      expect((previous?.confidence ?? 0) >= (current?.confidence ?? 0)).toBe(
        true,
      );
    }
  });

  it("keeps every confidence inside 0..1", () => {
    const samples = ["Save", "min", "GG", "Steam", "Right", "Commit"];
    for (const sample of samples) {
      for (const flag of detectAmbiguities("x", sample, "button")) {
        expect(flag.confidence).toBeGreaterThan(0);
        expect(flag.confidence).toBeLessThanOrEqual(1);
      }
    }
  });

  it("ships a substantial curated table", () => {
    expect(ambiguityTermCount()).toBeGreaterThan(110);
  });
});
