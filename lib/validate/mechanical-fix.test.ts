import { describe, expect, it } from "vitest";
import {
  applyMechanicalFixes,
  describeMechanicalFixes,
  type MechanicalFixKind,
} from "./mechanical-fix";
import { validateString } from "./validators";

function kinds(source: string, target: string): MechanicalFixKind[] {
  return applyMechanicalFixes(source, target).applied.map((f) => f.kind);
}

describe("applyMechanicalFixes", () => {
  it("does nothing to a clean translation", () => {
    const result = applyMechanicalFixes("Save changes", "Änderungen speichern");
    expect(result.text).toBe("Änderungen speichern");
    expect(result.applied).toEqual([]);
    expect(result.changed).toBe(false);
  });

  it("is idempotent", () => {
    const source = "Hello, ";
    const messy = '```\n"Hallo,"\n```';
    const once = applyMechanicalFixes(source, messy);
    const twice = applyMechanicalFixes(source, once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.applied).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const source = " Hello ";
    const target = "Hallo";
    applyMechanicalFixes(source, target);
    expect(source).toBe(" Hello ");
    expect(target).toBe("Hallo");
  });

  describe("markdown fences", () => {
    it("strips a bare fence", () => {
      const result = applyMechanicalFixes("Save", "```\nSpeichern\n```");
      expect(result.text).toBe("Speichern");
      expect(kinds("Save", "```\nSpeichern\n```")).toContain("strip-code-fence");
    });

    it("strips a language-tagged fence", () => {
      expect(applyMechanicalFixes("Save", "```json\nSpeichern\n```").text).toBe(
        "Speichern",
      );
    });

    it("leaves fences alone when the source has one", () => {
      const source = "Run ```npm test``` first";
      const target = "Führe ```npm test``` zuerst aus";
      expect(applyMechanicalFixes(source, target).text).toBe(target);
    });
  });

  describe("wrapping quotes", () => {
    it("strips straight double quotes", () => {
      expect(applyMechanicalFixes("Save", '"Speichern"').text).toBe("Speichern");
    });

    it("strips smart quotes and guillemets", () => {
      expect(applyMechanicalFixes("Save", "“Speichern”").text).toBe("Speichern");
      expect(applyMechanicalFixes("Save", "«Enregistrer»").text).toBe(
        "Enregistrer",
      );
    });

    it("strips a double wrap", () => {
      expect(applyMechanicalFixes("Save", '"“Speichern”"').text).toBe(
        "Speichern",
      );
    });

    it("leaves quotes alone when the source is itself a quoted string", () => {
      const target = "«Bonjour»";
      expect(applyMechanicalFixes('"Hello"', target).text).toBe(target);
    });

    it("leaves an apostrophe-heavy translation alone", () => {
      const target = "L'élément n'existe pas";
      expect(applyMechanicalFixes("The item does not exist", target).text).toBe(target);
    });

    it("refuses to strip when the interior contains the same quote", () => {
      const target = '"He said "hi""';
      expect(applyMechanicalFixes("He said hi", target).text).toBe(target);
    });
  });

  describe("placeholder repair", () => {
    it("unescapes over-escaped braces", () => {
      const result = applyMechanicalFixes("Hi {name}", "Hallo \\{name\\}");
      expect(result.text).toBe("Hallo {name}");
      expect(result.applied.map((f) => f.kind)).toContain(
        "unescape-placeholder-braces",
      );
    });

    it("leaves escapes alone when the source has them too", () => {
      const target = "Literal \\{braces\\}";
      expect(applyMechanicalFixes("Literal \\{braces\\}", target).text).toBe(target);
    });

    it("normalises a non-breaking space inside placeholder delimiters", () => {
      const result = applyMechanicalFixes("Hi {name}", "Hola {\u00A0name}");
      expect(result.text).toBe("Hola { name}");
      expect(result.applied.map((f) => f.kind)).toContain(
        "normalize-placeholder-spaces",
      );
    });

    it("leaves a non-breaking space outside placeholders alone (French typography)", () => {
      const target = "Enregistrer\u00A0: {name}";
      expect(applyMechanicalFixes("Save: {name}", target).text).toBe(target);
    });
  });

  describe("invalid characters", () => {
    it("strips C0 controls", () => {
      const result = applyMechanicalFixes("Bell", "Klinge\u0007l");
      expect(result.text).toBe("Klingel");
      expect(result.applied[0]?.kind).toBe("strip-control-characters");
    });

    it("strips C1 controls", () => {
      expect(applyMechanicalFixes("Quote", "Zita\u0093t").text).toBe("Zitat");
    });

    it("keeps tabs and newlines", () => {
      const target = "Zeile\tA\nZeile B";
      expect(applyMechanicalFixes("Line\tA\nLine B", target).text).toBe(target);
    });

    it("keeps CR when the source uses CRLF", () => {
      expect(applyMechanicalFixes("a\r\nb", "x\r\ny").text).toBe("x\r\ny");
      expect(applyMechanicalFixes("a\nb", "x\r\ny").text).toBe("x\ny");
    });

    it("strips zero-width spaces", () => {
      const result = applyMechanicalFixes("Hi there", "Hallo\u200B da");
      expect(result.text).toBe("Hallo da");
      expect(result.applied.map((f) => f.kind)).toContain("strip-zero-width");
    });

    it("preserves ZWJ emoji sequences and Persian ZWNJ", () => {
      expect(applyMechanicalFixes("family", "\u{1F468}\u200D\u{1F469}").text).toBe(
        "\u{1F468}\u200D\u{1F469}",
      );
      expect(applyMechanicalFixes("becomes", "می\u200Cشود").text).toBe(
        "می\u200Cشود",
      );
    });

    it("deliberately keeps U+FFFD so mojibake cannot ship silently", () => {
      const result = applyMechanicalFixes("Green", "Gr\uFFFDn");
      expect(result.text).toBe("Gr\uFFFDn");
      expect(result.applied).toEqual([]);
    });

    it("keeps a zero-width character the source itself carries", () => {
      expect(applyMechanicalFixes("a\u200Bb", "x\u200By").text).toBe("x\u200By");
    });
  });

  describe("spacing", () => {
    it("collapses doubled spaces the model introduced", () => {
      const result = applyMechanicalFixes("Save all files", "Alle  Dateien  speichern");
      expect(result.text).toBe("Alle Dateien speichern");
      expect(result.applied.map((f) => f.kind)).toContain("collapse-double-spaces");
    });

    it("leaves doubled spaces alone when the source uses them", () => {
      const target = "Alle  Dateien";
      expect(applyMechanicalFixes("All  files", target).text).toBe(target);
    });

    it("restores a lost trailing space", () => {
      const result = applyMechanicalFixes("Hello, ", "Hallo,");
      expect(result.text).toBe("Hallo, ");
      expect(result.applied.map((f) => f.kind)).toContain("restore-trailing-whitespace");
    });

    it("restores a lost leading space", () => {
      const result = applyMechanicalFixes(" of {total}", "von {total}");
      expect(result.text).toBe(" von {total}");
      expect(result.applied.map((f) => f.kind)).toContain("restore-leading-whitespace");
    });

    it("removes edge whitespace the source does not have", () => {
      expect(applyMechanicalFixes("Save", "  Speichern\n").text).toBe("Speichern");
    });

    it("restores both edges at once", () => {
      const result = applyMechanicalFixes("\tHello ", "Hallo");
      expect(result.text).toBe("\tHallo ");
      expect(result.applied).toHaveLength(2);
    });

    it("does not turn an empty translation into whitespace", () => {
      const result = applyMechanicalFixes(" Hello ", "");
      expect(result.text).toBe("");
      expect(result.applied).toEqual([]);
    });

    it("leaves an all-whitespace source alone", () => {
      expect(applyMechanicalFixes("   ", "x").text).toBe("x");
    });
  });

  describe("end to end", () => {
    it("repairs a realistically mangled model response", () => {
      const source = "Deleting {count} files… ";
      const target = '```\n"Lösche \\{count\\}\u200B  Dateien…"\n```';
      const result = applyMechanicalFixes(source, target);
      expect(result.text).toBe("Lösche {count} Dateien… ");
      expect(result.applied.map((f) => f.kind)).toEqual([
        "strip-code-fence",
        "strip-wrapping-quotes",
        "unescape-placeholder-braces",
        "strip-zero-width",
        "collapse-double-spaces",
        "restore-trailing-whitespace",
      ]);
    });

    it("clears the validators it is meant to clear", () => {
      const source = "Save {count} items ";
      const target = ' "Speichere \\{count\\} Objekte"';
      const before = validateString(source, target, { locale: "de", sourceLocale: "en" });
      expect(before.length).toBeGreaterThan(0);

      const fixed = applyMechanicalFixes(source, target);
      const after = validateString(source, fixed.text, {
        locale: "de",
        sourceLocale: "en",
      });
      expect(after).toEqual([]);
    });
  });
});

describe("describeMechanicalFixes", () => {
  it("says so when nothing ran", () => {
    expect(describeMechanicalFixes([])).toBe("No mechanical fixes were needed.");
  });

  it("joins the notes", () => {
    const { applied } = applyMechanicalFixes("Hello, ", "Hallo,");
    expect(describeMechanicalFixes(applied)).toContain("trailing whitespace");
  });
});
