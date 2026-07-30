import { describe, expect, it } from "vitest";
import {
  detectIndent,
  inferLocaleFromFileName,
  JsonParseError,
  parseSourceFile,
  serializeWithCatalogFormatting,
} from "./parse";

const twoSpace = `{
  "app": {
    "title": "LingoLoop",
    "version": 3
  }
}
`;

describe("parseSourceFile", () => {
  it("returns a catalog with entries in document order", () => {
    const catalog = parseSourceFile("en.json", twoSpace);
    expect(catalog.fileName).toBe("en.json");
    expect(catalog.entries.map((e) => e.key)).toEqual(["app.title"]);
    expect(catalog.tree).toEqual({ app: { title: "LingoLoop", version: 3 } });
  });

  it("detects two-space, four-space and tab indentation", () => {
    expect(parseSourceFile("en.json", twoSpace).indent).toBe("  ");
    expect(detectIndent('{\n    "a": "b"\n}')).toBe("    ");
    expect(detectIndent('{\n\t"a": "b"\n}')).toBe("\t");
    expect(detectIndent('{"a":"b"}')).toBe("");
  });

  it("records whether the file ended with a newline", () => {
    expect(parseSourceFile("en.json", twoSpace).trailingNewline).toBe(true);
    expect(parseSourceFile("en.json", '{"a":"b"}').trailingNewline).toBe(false);
  });

  it("re-emits with the original formatting", () => {
    const catalog = parseSourceFile("en.json", twoSpace);
    expect(serializeWithCatalogFormatting(catalog, catalog.tree)).toBe(
      twoSpace,
    );
  });

  it("re-emits minified files minified", () => {
    const raw = '{"a":"b","n":[1,2]}';
    const catalog = parseSourceFile("en.json", raw);
    expect(serializeWithCatalogFormatting(catalog, catalog.tree)).toBe(raw);
  });

  it("tolerates a UTF-8 BOM", () => {
    const catalog = parseSourceFile("en.json", `﻿{"a":"b"}`);
    expect(catalog.entries).toHaveLength(1);
  });

  it("computes accurate stats", () => {
    const catalog = parseSourceFile(
      "en.json",
      JSON.stringify({
        _comment: "internal",
        title: "Hello",
        count: 3,
        url: "https://example.com",
        nested: { list: ["Go", ""] },
      }),
    );
    // Leaves: _comment, title, count, url, list[0], list[1] = 6
    expect(catalog.stats.totalKeys).toBe(6);
    // Translatable: title, list[0]
    expect(catalog.stats.translatableKeys).toBe(2);
    expect(catalog.stats.skippedKeys).toBe(4);
    expect(catalog.stats.totalCharacters).toBe("Hello".length + "Go".length);
    expect(catalog.stats.maxDepth).toBe(3);
  });

  it("infers the source locale from the file name", () => {
    expect(parseSourceFile("de.json", '{"a":"b"}').sourceLocale).toBe("de");
    expect(parseSourceFile("pt_br.json", '{"a":"b"}').sourceLocale).toBe(
      "pt-BR",
    );
    expect(inferLocaleFromFileName("locales/fr/common.json")).toBe("fr");
    expect(inferLocaleFromFileName("messages.ja.json")).toBe("ja");
    expect(inferLocaleFromFileName("zh-Hans.json")).toBe("zh-Hans");
    expect(inferLocaleFromFileName("translation.json")).toBeNull();
    expect(parseSourceFile("translation.json", '{"a":"b"}').sourceLocale).toBe(
      "en",
    );
  });

  it("honours an explicit source locale", () => {
    expect(
      parseSourceFile("whatever.json", '{"a":"b"}', { sourceLocale: "sv" })
        .sourceLocale,
    ).toBe("sv");
  });
});

describe("parseSourceFile errors", () => {
  it("reports line, column and a caret snippet", () => {
    const broken = '{\n  "a": 1,\n  "b" 2\n}\n';
    let thrown: unknown;
    try {
      parseSourceFile("en.json", broken);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(JsonParseError);
    const error = thrown as JsonParseError;
    expect(error.line).toBe(3);
    expect(error.column).toBeGreaterThan(1);
    expect(error.snippet).toContain('"b" 2');
    expect(error.snippet).toContain("^");
    expect(error.message).toContain("en.json");
    expect(error.message).toContain("line 3");
  });

  it("rejects an empty file with a helpful message", () => {
    expect(() => parseSourceFile("en.json", "   ")).toThrow(/empty/i);
  });

  it("rejects non-object roots by name", () => {
    expect(() => parseSourceFile("en.json", "[1,2,3]")).toThrow(/an array/);
    expect(() => parseSourceFile("en.json", '"just a string"')).toThrow(
      /a string/,
    );
    expect(() => parseSourceFile("en.json", "null")).toThrow(/null/);
    expect(() => parseSourceFile("en.json", "42")).toThrow(/a number/);
  });

  it("does not leak the engine's own position suffix into the reason", () => {
    try {
      parseSourceFile("en.json", '{"a": }');
    } catch (error) {
      expect((error as JsonParseError).reason).not.toMatch(/position \d+/);
    }
  });
});
