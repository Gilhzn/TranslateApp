import { describe, expect, it } from "vitest";
import type { FitResult, GlossaryTerm, Issue, IssueCode } from "@/lib/types";
import {
  issuesFromFit,
  placeholderIdentity,
  validateCasingDrift,
  validateControlCharacters,
  validateNotEmpty,
  validatePlaceholderParity,
  validateString,
  validateTagBalance,
  validateTranslation,
  validateUntranslated,
  validateWhitespaceDrift,
} from "./validators";
import { extractPlaceholders } from "@/lib/core";

function codes(issues: readonly Issue[]): IssueCode[] {
  return issues.map((i) => i.code);
}

function only(issues: readonly Issue[], code: IssueCode): Issue[] {
  return issues.filter((i) => i.code === code);
}

// ---------------------------------------------------------------------------

describe("placeholderIdentity", () => {
  it("separates syntaxes that look alike", () => {
    const [icu] = extractPlaceholders("{user}");
    const [mustache] = extractPlaceholders("{{user}}");
    const [dollar] = extractPlaceholders("${user}");
    expect(icu && mustache && dollar).toBeTruthy();
    const ids = new Set([
      placeholderIdentity(icu!),
      placeholderIdentity(mustache!),
      placeholderIdentity(dollar!),
    ]);
    expect(ids.size).toBe(3);
  });

  it("separates opening, closing and self-closing tags", () => {
    const tags = extractPlaceholders("<b></b><br/>");
    expect(tags).toHaveLength(3);
    const ids = tags.map(placeholderIdentity);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("validatePlaceholderParity", () => {
  it("passes a faithful translation", () => {
    expect(
      validatePlaceholderParity("Hello {name}, you have {count} new messages", "Hallo {name}, du hast {count} neue Nachrichten"),
    ).toEqual([]);
  });

  it("passes when there are no placeholders at all", () => {
    expect(validatePlaceholderParity("Settings", "Einstellungen")).toEqual([]);
  });

  it("reports a dropped placeholder", () => {
    const issues = validatePlaceholderParity("Delete {count} items?", "Elemente löschen?");
    expect(codes(issues)).toContain("placeholder-missing");
    const missing = only(issues, "placeholder-missing")[0];
    expect(missing?.detail?.raw).toBe("{count}");
    expect(missing?.severity).toBe("error");
  });

  it("compares by MULTISET — a token used twice must appear twice", () => {
    const issues = validatePlaceholderParity(
      "{name} invited {name}",
      "{name} hat eingeladen",
    );
    const missing = only(issues, "placeholder-missing")[0];
    expect(missing).toBeDefined();
    expect(missing?.detail?.expected).toBe(2);
    expect(missing?.detail?.actual).toBe(1);
  });

  it("reports an added placeholder", () => {
    const issues = validatePlaceholderParity("Welcome back", "Willkommen zurück, {name}");
    expect(codes(issues)).toContain("placeholder-added");
    expect(only(issues, "placeholder-added")[0]?.detail?.raw).toBe("{name}");
  });

  it("reports over-use of an existing placeholder", () => {
    const issues = validatePlaceholderParity("Hi {name}", "Hi {name} {name}");
    const added = only(issues, "placeholder-added")[0];
    expect(added?.detail?.expected).toBe(1);
    expect(added?.detail?.actual).toBe(2);
  });

  it("reports a syntax swap once, as a malformed placeholder", () => {
    // `{{name}}` rewritten as `{name}` is one mistake, not a loss plus an
    // addition — the repair instruction is "write it exactly as {{name}}".
    const issues = validatePlaceholderParity("Hi {{name}}", "Hi {name}");
    expect(codes(issues)).toEqual(["placeholder-malformed"]);
    expect(issues[0]?.detail?.raw).toBe("{{name}}");
    expect(issues[0]?.severity).toBe("error");
  });

  it("reports a genuinely different token as an addition", () => {
    const issues = validatePlaceholderParity("Hi {name}", "Hi {user}");
    expect(codes(issues).sort()).toEqual(["placeholder-added", "placeholder-missing"]);
  });

  it("flags a truncated placeholder as malformed, not missing", () => {
    const issues = validatePlaceholderParity("Save {count} items", "Speichere {count Elemente");
    expect(codes(issues)).toContain("placeholder-malformed");
    expect(codes(issues)).not.toContain("placeholder-missing");
  });

  it("flags full-width delimiters", () => {
    const issues = validatePlaceholderParity("Save {count} items", "保存｛count｝件");
    const malformed = only(issues, "placeholder-malformed");
    expect(malformed.length).toBeGreaterThan(0);
  });

  it("flags a non-breaking space inside placeholder delimiters", () => {
    const issues = validatePlaceholderParity("Hi {name}", "Hola {\u00A0name}");
    const malformed = only(issues, "placeholder-malformed")[0];
    expect(malformed).toBeDefined();
    expect(malformed?.detail?.codePoint).toBe("U+00A0");
    expect(malformed?.detail?.fixable).toBe(true);
  });

  it("flags invented unbalanced braces", () => {
    const issues = validatePlaceholderParity("Ready", "Bereit }");
    expect(only(issues, "placeholder-malformed")[0]?.detail?.reason).toBe(
      "unbalanced-braces",
    );
  });

  it("allows reordering of named placeholders at INFO severity", () => {
    const issues = validatePlaceholderParity(
      "{count} results for {query}",
      "{query} で {count} 件の結果",
    );
    const reordered = only(issues, "placeholder-reordered")[0];
    expect(reordered).toBeDefined();
    expect(reordered?.severity).toBe("info");
    expect(issues.every((i) => i.severity !== "error")).toBe(true);
  });

  it("does not report reordering when the order is preserved", () => {
    const issues = validatePlaceholderParity(
      "{count} results for {query}",
      "{count} Ergebnisse für {query}",
    );
    expect(codes(issues)).not.toContain("placeholder-reordered");
  });

  it("escalates reordering to ERROR for positional printf", () => {
    const issues = validatePlaceholderParity("%s wrote %d comments", "%d Kommentare von %s");
    const reordered = only(issues, "placeholder-reordered")[0];
    expect(reordered?.severity).toBe("error");
    expect(reordered?.detail?.positional).toBe(true);
  });

  it("allows reordering of printf specs that carry explicit argument indices", () => {
    const issues = validatePlaceholderParity(
      "%1$s wrote %2$d comments",
      "%2$d Kommentare von %1$s",
    );
    const reordered = only(issues, "placeholder-reordered")[0];
    expect(reordered?.severity).toBe("info");
  });

  it("allows reordering of %(named)s specs", () => {
    const issues = validatePlaceholderParity(
      "%(count)d items in %(folder)s",
      "%(folder)s enthält %(count)d Elemente",
    );
    expect(only(issues, "placeholder-reordered")[0]?.severity).toBe("info");
  });

  it("does not escalate when only one positional spec exists", () => {
    const issues = validatePlaceholderParity("Hello %s, welcome", "Willkommen, %s");
    expect(issues.every((i) => i.severity !== "error")).toBe(true);
  });

  it("reuses pre-extracted source placeholders", () => {
    const placeholders = extractPlaceholders("Hi {name}");
    const issues = validatePlaceholderParity("Hi {name}", "Hallo", {
      sourcePlaceholders: placeholders,
    });
    expect(codes(issues)).toEqual(["placeholder-missing"]);
  });

  it("attaches the entry key to every issue", () => {
    const issues = validatePlaceholderParity("Hi {name}", "Hallo", { key: "greeting" });
    expect(issues.every((i) => i.key === "greeting")).toBe(true);
  });

  it("handles ICU plural blocks as a single argument", () => {
    const source = "{count, plural, one {# item} other {# items}}";
    const target = "{count, plural, one {# Element} other {# Elemente}}";
    expect(validatePlaceholderParity(source, target)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("validateNotEmpty", () => {
  it("accepts a real translation", () => {
    expect(validateNotEmpty("Save", "Speichern")).toEqual([]);
  });

  it("rejects an empty target for a non-empty source", () => {
    const issues = validateNotEmpty("Save", "");
    expect(codes(issues)).toEqual(["empty-translation"]);
    expect(issues[0]?.severity).toBe("error");
  });

  it("rejects a whitespace-only target", () => {
    expect(codes(validateNotEmpty("Save", "   \n"))).toEqual(["empty-translation"]);
  });

  it("rejects a target made only of zero-width characters", () => {
    expect(codes(validateNotEmpty("Save", "\u200B\uFEFF"))).toEqual(["empty-translation"]);
  });

  it("accepts an empty target for an empty source", () => {
    expect(validateNotEmpty("", "")).toEqual([]);
    expect(validateNotEmpty("   ", "")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("validateUntranslated", () => {
  const ctx = { locale: "de", sourceLocale: "en" };

  it("warns when the target is identical to the source", () => {
    const issues = validateUntranslated("Save changes", "Save changes", ctx);
    expect(codes(issues)).toEqual(["untranslated"]);
    expect(issues[0]?.severity).toBe("warning");
  });

  it("stays silent for a real translation", () => {
    expect(validateUntranslated("Save changes", "Änderungen speichern", ctx)).toEqual([]);
  });

  it("does not fire for doNotTranslate entries", () => {
    expect(
      validateUntranslated("https://example.com", "https://example.com", {
        ...ctx,
        doNotTranslate: true,
      }),
    ).toEqual([]);
  });

  it("does not fire when the target locale shares the source language", () => {
    expect(
      validateUntranslated("Colour", "Colour", { locale: "en-GB", sourceLocale: "en" }),
    ).toEqual([]);
  });

  it("does not fire for pure-placeholder strings", () => {
    expect(validateUntranslated("{{first}} {{last}}", "{{first}} {{last}}", ctx)).toEqual([]);
  });

  it("does not fire for strings with no letters", () => {
    expect(validateUntranslated("42%", "42%", ctx)).toEqual([]);
    expect(validateUntranslated("→", "→", ctx)).toEqual([]);
  });

  it("does not fire for glossary terms kept verbatim", () => {
    const glossary: GlossaryTerm[] = [
      { term: "Nebula", translations: {}, caseSensitive: true },
    ];
    expect(validateUntranslated("Nebula", "Nebula", { ...ctx, glossary })).toEqual([]);
  });

  it("does not fire when the glossary forces the source spelling", () => {
    const glossary: GlossaryTerm[] = [
      { term: "Loot", translations: { de: "Loot" }, caseSensitive: false },
    ];
    expect(validateUntranslated("Loot", "Loot", { ...ctx, glossary })).toEqual([]);
  });

  it("still fires when the glossary demands a different rendering", () => {
    const glossary: GlossaryTerm[] = [
      { term: "Loot", translations: { de: "Beute" }, caseSensitive: false },
    ];
    expect(codes(validateUntranslated("Loot", "Loot", { ...ctx, glossary }))).toEqual([
      "untranslated",
    ]);
  });

  it("does not fire for short strings the analyser flagged as brand terms", () => {
    expect(
      validateUntranslated("Nebula Forge", "Nebula Forge", {
        ...ctx,
        ambiguities: [{ kind: "brand-term", note: "product name", confidence: 0.9 }],
      }),
    ).toEqual([]);
  });

  it("still fires for a long sentence that merely mentions a brand", () => {
    const sentence = "Nebula Forge could not connect to the build server right now";
    expect(
      codes(
        validateUntranslated(sentence, sentence, {
          ...ctx,
          ambiguities: [{ kind: "brand-term", note: "product name", confidence: 0.9 }],
        }),
      ),
    ).toEqual(["untranslated"]);
  });

  it("ignores differences that are only edge whitespace", () => {
    expect(codes(validateUntranslated("Save ", "Save", ctx))).toEqual(["untranslated"]);
  });
});

// ---------------------------------------------------------------------------

describe("validateControlCharacters", () => {
  it("accepts tabs and newlines", () => {
    expect(validateControlCharacters("a\tb\nc", "x\ty\nz")).toEqual([]);
  });

  it("rejects C0 controls as errors", () => {
    const issues = validateControlCharacters("Bell", "Klingel\u0007");
    expect(codes(issues)).toEqual(["control-characters"]);
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.detail?.codePoint).toBe("U+0007");
  });

  it("rejects C1 controls (cp1252 mojibake)", () => {
    const issues = validateControlCharacters("Quote", "Zitat\u0093");
    expect(issues[0]?.detail?.codePoint).toBe("U+0093");
    expect(issues[0]?.severity).toBe("error");
  });

  it("rejects the replacement character as an error", () => {
    const issues = validateControlCharacters("Grün", "Gr\uFFFDn");
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.detail?.codePoint).toBe("U+FFFD");
  });

  it("flags zero-width characters as fixable warnings", () => {
    const issues = validateControlCharacters("Hi there", "Hallo\u200B da");
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.detail?.fixable).toBe(true);
  });

  it("aggregates repeats of the same code point into one issue", () => {
    const issues = validateControlCharacters("abc", "a\u200Bb\u200Bc\u200B");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.detail?.count).toBe(3);
  });

  it("tolerates CR when the source itself uses CRLF", () => {
    expect(validateControlCharacters("a\r\nb", "x\r\ny")).toEqual([]);
    expect(codes(validateControlCharacters("a\nb", "x\r\ny"))).toEqual([
      "control-characters",
    ]);
  });

  it("does not flag ZWNJ in locales whose orthography needs it", () => {
    expect(validateControlCharacters("test", "می\u200Cشود", { locale: "fa" })).toEqual([]);
  });

  it("flags a stray ZWJ in a locale that does not use one", () => {
    const issues = validateControlCharacters("family", "Fami\u200Dlie", { locale: "de" });
    expect(codes(issues)).toEqual(["control-characters"]);
    expect(issues[0]?.severity).toBe("warning");
  });

  it("does not flag ZWJ inside an emoji sequence", () => {
    expect(validateControlCharacters("family", "👨\u200D👩\u200D👦", { locale: "de" })).toEqual(
      [],
    );
  });

  it("does not flag bidi marks, which RTL layouts require", () => {
    expect(validateControlCharacters("Hi {n}", "\u200F{n} مرحبا", { locale: "ar" })).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------

describe("validateTagBalance", () => {
  it("accepts balanced markup", () => {
    expect(validateTagBalance("Click <b>here</b>", "Klicke <b>hier</b>")).toEqual([]);
  });

  it("accepts reordered but balanced markup", () => {
    expect(
      validateTagBalance("<b>Save</b> your <i>work</i>", "Deine <i>Arbeit</i> <b>speichern</b>"),
    ).toEqual([]);
  });

  it("reports an unclosed tag", () => {
    const issues = validateTagBalance("Click <b>here</b>", "Klicke <b>hier");
    const imbalance = only(issues, "tag-imbalance")[0];
    expect(imbalance?.detail?.reason).toBe("unclosed");
    expect(imbalance?.detail?.expected).toBe("</b>");
  });

  it("reports a closing tag with no opener", () => {
    const issues = validateTagBalance("<b>x</b>", "hier</b>");
    expect(only(issues, "tag-imbalance")[0]?.detail?.reason).toBe("unopened");
  });

  it("reports crossed nesting", () => {
    const issues = validateTagBalance("<b><i>x</i></b>", "<b><i>x</b></i>");
    expect(only(issues, "tag-imbalance").some((i) => i.detail?.reason === "crossed")).toBe(
      true,
    );
  });

  it("ignores self-closing and void tags", () => {
    expect(validateTagBalance("Line<br/>break", "Zeilen<br/>umbruch")).toEqual([]);
    expect(validateTagBalance("Line<br>break", "Zeilen<br>umbruch")).toEqual([]);
  });

  it("does not demand balance for tags the source itself leaves open", () => {
    // Component-interpolation catalogues legitimately split a tag across keys.
    expect(validateTagBalance("<0>Start of", "<0>Anfang von")).toEqual([]);
  });

  it("handles numeric component tags", () => {
    expect(validateTagBalance("<0>Read</0> more", "<0>Mehr</0> lesen")).toEqual([]);
    expect(
      only(validateTagBalance("<0>Read</0> more", "<0>Mehr lesen"), "tag-imbalance"),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("validateWhitespaceDrift", () => {
  it("accepts matching edges", () => {
    expect(validateWhitespaceDrift("Hello, ", "Hallo, ")).toEqual([]);
  });

  it("reports a lost trailing space", () => {
    const issues = validateWhitespaceDrift("Hello, ", "Hallo,");
    expect(codes(issues)).toEqual(["whitespace-drift"]);
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.detail?.side).toBe("trailing");
    expect(issues[0]?.detail?.expected).toBe(" ");
    expect(issues[0]?.detail?.fixable).toBe(true);
  });

  it("reports a lost leading space", () => {
    const issues = validateWhitespaceDrift(" of {total}", "von {total}");
    expect(issues[0]?.detail?.side).toBe("leading");
  });

  it("reports an invented trailing space", () => {
    expect(codes(validateWhitespaceDrift("Save", "Speichern "))).toEqual([
      "whitespace-drift",
    ]);
  });

  it("reports both edges independently", () => {
    expect(validateWhitespaceDrift(" x ", "y")).toHaveLength(2);
  });

  it("stays quiet for an empty target — that is the emptiness validator's job", () => {
    expect(validateWhitespaceDrift("Hello, ", "")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("validateCasingDrift", () => {
  it("only applies to style-sensitive roles", () => {
    expect(validateCasingDrift("SAVE", "speichern", { role: "body", locale: "de" })).toEqual(
      [],
    );
    expect(validateCasingDrift("SAVE", "speichern", { locale: "de" })).toEqual([]);
  });

  it("flags a lost ALL CAPS style on a button", () => {
    const issues = validateCasingDrift("SAVE", "speichern", { role: "button", locale: "de" });
    expect(codes(issues)).toEqual(["casing-drift"]);
    expect(issues[0]?.severity).toBe("info");
    expect(issues[0]?.detail?.style).toBe("all-caps");
  });

  it("accepts a preserved ALL CAPS style", () => {
    expect(validateCasingDrift("SAVE", "SPEICHERN", { role: "button", locale: "de" })).toEqual(
      [],
    );
  });

  it("does not fire for caseless scripts", () => {
    expect(validateCasingDrift("SAVE", "保存", { role: "button", locale: "ja" })).toEqual([]);
    expect(validateCasingDrift("SAVE", "저장", { role: "button", locale: "ko" })).toEqual([]);
    expect(validateCasingDrift("SAVE", "حفظ", { role: "button", locale: "ar" })).toEqual([]);
  });

  it("flags lost Title Case in a locale that does not capitalise nouns", () => {
    const issues = validateCasingDrift("Save As", "enregistrer sous", {
      role: "menu",
      locale: "fr",
    });
    expect(issues[0]?.detail?.style).toBe("title-case");
  });

  it("does not fire on Title Case for German, where nouns are capitalised anyway", () => {
    expect(
      validateCasingDrift("Save As", "speichern unter", { role: "menu", locale: "de" }),
    ).toEqual([]);
  });

  it("flags a lowercased sentence-case button", () => {
    const issues = validateCasingDrift("Save", "enregistrer", { role: "button", locale: "fr" });
    expect(issues[0]?.detail?.style).toBe("sentence-case");
  });

  it("accepts Title Case that is mostly preserved", () => {
    expect(
      validateCasingDrift("Save As Draft", "Enregistrer Comme Brouillon", {
        role: "menu",
        locale: "fr",
      }),
    ).toEqual([]);
  });

  it("ignores single-letter sources, where ALL CAPS is indistinguishable", () => {
    expect(validateCasingDrift("X", "x", { role: "badge", locale: "fr" })).toHaveLength(1);
    expect(validateCasingDrift("X", "X", { role: "badge", locale: "fr" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("issuesFromFit", () => {
  const budget = {
    maxRatio: 1.3,
    maxChars: 18,
    graceRatio: 1.05,
    rationale: "button labels sit in a fixed-width control",
  };

  function fit(verdict: FitResult["verdict"], overBy = 0): FitResult {
    return {
      verdict,
      sourceWidth: 4,
      targetWidth: verdict === "fits" ? 4 : 7,
      ratio: verdict === "fits" ? 1 : 1.75,
      budget,
      allowedWidth: 5.2,
      overBy,
    };
  }

  it("returns nothing for a null fit or a fitting translation", () => {
    expect(issuesFromFit(null)).toEqual([]);
    expect(issuesFromFit(fit("fits"))).toEqual([]);
  });

  it("emits an error for overflow with the numbers attached", () => {
    const issues = issuesFromFit(fit("overflow", 6), "menu.save");
    expect(codes(issues)).toEqual(["length-overflow"]);
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.key).toBe("menu.save");
    expect(issues[0]?.detail?.overBy).toBe(6);
    expect(issues[0]?.detail?.allowedWidth).toBe(5.2);
  });

  it("emits a warning for a tight fit", () => {
    const issues = issuesFromFit(fit("tight"));
    expect(codes(issues)).toEqual(["length-tight"]);
    expect(issues[0]?.severity).toBe("warning");
  });
});

// ---------------------------------------------------------------------------

describe("validateString / validateTranslation", () => {
  it("returns nothing for a clean translation", () => {
    expect(
      validateString("Delete {count} items", "{count} Elemente löschen", {
        key: "a",
        role: "button",
        locale: "de",
        sourceLocale: "en",
      }),
    ).toEqual([]);
  });

  it("collects findings from several validators at once", () => {
    const issues = validateString("Save {count} items ", "Speichere\u0007", {
      key: "a",
      locale: "de",
      sourceLocale: "en",
    });
    const found = new Set(codes(issues));
    expect(found.has("placeholder-missing")).toBe(true);
    expect(found.has("control-characters")).toBe(true);
    expect(found.has("whitespace-drift")).toBe(true);
  });

  it("puts the structural failure first so it becomes the headline", () => {
    const issues = validateString("Save {count}", "Speichern", { key: "a" });
    expect(issues[0]?.code).toBe("placeholder-missing");
  });

  it("validateTranslation folds in the layout verdict", () => {
    const issues = validateTranslation(
      "Save",
      "Alle Änderungen speichern",
      {
        verdict: "overflow",
        sourceWidth: 2.2,
        targetWidth: 12,
        ratio: 5.45,
        budget: { maxRatio: 1.3, maxChars: 18, graceRatio: 1.05, rationale: "button" },
        allowedWidth: 2.9,
        overBy: 16,
      },
      { key: "a", role: "button", locale: "de", sourceLocale: "en" },
    );
    expect(codes(issues)).toContain("length-overflow");
  });
});
