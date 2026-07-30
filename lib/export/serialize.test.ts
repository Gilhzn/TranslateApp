import { describe, expect, it } from "vitest";
import { parseSourceFile } from "@/lib/core";
import { estimateLongestLineWidth, evaluateFit, getLocaleProfile } from "@/lib/layout";
import type {
  JsonValue,
  LocaleCode,
  LocaleResult,
  SourceCatalog,
  TranslatedEntry,
  UiRole,
} from "@/lib/types";
import { readZip } from "./zip";
import { buildLocaleArchive, defaultArchiveName } from "./archive";
import {
  ExportValidationError,
  buildFileName,
  joinExportPath,
  serializeAllLocales,
  serializeLocaleResult,
  serializeLocaleResultDetailed,
  type ExportCatalog,
} from "./serialize";

const SOURCE = [
  "{",
  '    "meta": {',
  '        "version": "1.4.2",',
  '        "build": 4211,',
  '        "beta": true,',
  '        "channel": null',
  "    },",
  '    "12": "twelfth slot",',
  '    "7": "seventh slot",',
  '    "menu": {',
  '        "save": "Save",',
  '        "floor": "Floor {n}"',
  "    },",
  '    "cards": [',
  "        {",
  '            "name": "Strike",',
  '            "cost": 1',
  "        },",
  "        []",
  "    ]",
  "}",
].join("\n");

function catalogOf(raw = SOURCE, fileName = "en.json"): ExportCatalog {
  return parseSourceFile(fileName, raw);
}

function entry(
  key: string,
  source: string,
  target: string,
  locale: LocaleCode,
  role: UiRole = "label",
): TranslatedEntry {
  const profile = getLocaleProfile(locale);
  const fit = evaluateFit(source, target, role, profile);
  return {
    key,
    path: key.split("."),
    source,
    target,
    locale,
    status: fit.verdict === "overflow" ? "failed" : "passed",
    issues: [],
    fit,
    attempts: 1,
  };
}

function resultOf(locale: LocaleCode, entries: TranslatedEntry[]): LocaleResult {
  return {
    locale,
    entries,
    // Deliberately wrong: the serialiser must rebuild from the source catalog,
    // never from whatever tree a pipeline stashed on the result.
    tree: { poisoned: true } as unknown as JsonValue,
    issues: [],
    stats: {
      total: entries.length,
      passed: entries.length,
      flagged: 0,
      failed: 0,
      overflowRepaired: 0,
      averageRatio: 1,
    },
  };
}

describe("buildFileName", () => {
  it("substitutes every supported token", () => {
    expect(buildFileName("{locale}.json", "pt-BR")).toBe("pt-BR.json");
    expect(buildFileName("{lang}.json", "pt-BR")).toBe("pt.json");
    expect(buildFileName("{LOCALE}.json", "pt-BR")).toBe("PT-BR.json");
    expect(buildFileName("{locale_underscore}.json", "pt-BR")).toBe("pt_BR.json");
    expect(buildFileName("messages_{locale}.arb", "de")).toBe("messages_de.arb");
  });

  it("keeps a token-free pattern verbatim", () => {
    expect(buildFileName("strings.json", "de")).toBe("strings.json");
  });

  it("normalises separators and strips a leading slash", () => {
    expect(buildFileName("/locales\\{locale}.json", "de")).toBe(
      "locales/de.json",
    );
  });

  it("refuses a pattern that produces nothing", () => {
    expect(() => buildFileName("{locale}", "")).toThrow(ExportValidationError);
  });
});

describe("joinExportPath", () => {
  it("joins and trims", () => {
    expect(joinExportPath("public/locales", "de.json")).toBe(
      "public/locales/de.json",
    );
    expect(joinExportPath("/public/locales/", "de.json")).toBe(
      "public/locales/de.json",
    );
    expect(joinExportPath("", "de.json")).toBe("de.json");
  });
});

describe("serializeLocaleResult — structural fidelity", () => {
  const catalog = catalogOf();
  const result = resultOf("de", [
    entry("menu.save", "Save", "Sichern", "de"),
    entry("menu.floor", "Floor {n}", "Ebene {n}", "de"),
  ]);

  const file = serializeLocaleResult(catalog, result);

  it("keeps the source indentation", () => {
    expect(file.contents).toContain('\n    "meta": {');
    expect(file.contents).toContain('\n        "version": "1.4.2"');
  });

  it("keeps integer-like keys in source order rather than numeric order", () => {
    const twelve = file.contents.indexOf('"12"');
    const seven = file.contents.indexOf('"7"');
    expect(twelve).toBeGreaterThan(-1);
    expect(twelve).toBeLessThan(seven);
  });

  it("keeps non-string leaves, empty containers and array lengths", () => {
    const parsed = JSON.parse(file.contents) as Record<string, JsonValue>;
    expect(parsed).toMatchObject({
      meta: { version: "1.4.2", build: 4211, beta: true, channel: null },
    });
    const cards = parsed.cards;
    expect(Array.isArray(cards)).toBe(true);
    expect((cards as JsonValue[]).length).toBe(2);
    expect((cards as JsonValue[])[1]).toEqual([]);
  });

  it("substitutes only the keys it was given", () => {
    const parsed = JSON.parse(file.contents) as {
      menu: { save: string; floor: string };
      cards: Array<{ name: string }>;
    };
    expect(parsed.menu.save).toBe("Sichern");
    expect(parsed.menu.floor).toBe("Ebene {n}");
    // Never translated: the source value survives untouched.
    expect(parsed.cards[0]?.name).toBe("Strike");
  });

  it("preserves the trailing-newline decision", () => {
    expect(file.contents.endsWith("\n")).toBe(false);
    const withNewline = serializeLocaleResult(catalogOf(`${SOURCE}\n`), result);
    expect(withNewline.contents.endsWith("\n")).toBe(true);
  });

  it("preserves CRLF line endings", () => {
    const crlf = catalogOf(SOURCE.replace(/\n/g, "\r\n"));
    const out = serializeLocaleResult(crlf, result);
    expect(out.contents).toContain("\r\n");
    expect(out.contents.split("\n").length).toBe(
      out.contents.split("\r\n").length,
    );
  });

  it("names the file from the locale", () => {
    expect(file.path).toBe("de.json");
    expect(
      serializeLocaleResult(catalog, result, {
        pattern: "{locale}.json",
        directory: "public/locales",
      }).path,
    ).toBe("public/locales/de.json");
  });
});

describe("serializeLocaleResult — layout enforcement", () => {
  const catalog = catalogOf();
  const profile = getLocaleProfile("de");
  const overflowing = entry(
    "menu.floor",
    "Floor {n}",
    "Kellerebene {n} des tiefen Verlieses",
    "de",
    "button",
  );

  it("only fires on entries the engine marked as overflowing", () => {
    expect(overflowing.fit?.verdict).toBe("overflow");
  });

  it("clips an overflowing entry so the emitted string fits", () => {
    const out = serializeLocaleResultDetailed(
      catalog,
      resultOf("de", [overflowing]),
    );
    const parsed = JSON.parse(out.file.contents) as {
      menu: { floor: string };
    };

    expect(out.clipped).toHaveLength(1);
    expect(out.clipped[0]?.key).toBe("menu.floor");
    expect(parsed.menu.floor).not.toBe(overflowing.target);
    expect(
      estimateLongestLineWidth(parsed.menu.floor, profile),
    ).toBeLessThanOrEqual(overflowing.fit?.allowedWidth ?? 0);
    expect(
      evaluateFit("Floor {n}", parsed.menu.floor, "button", profile).verdict,
    ).not.toBe("overflow");
  });

  it("never leaves a partial placeholder behind", () => {
    const out = serializeLocaleResult(catalog, resultOf("de", [overflowing]));
    const parsed = JSON.parse(out.contents) as { menu: { floor: string } };
    const value = parsed.menu.floor;
    // Either the whole placeholder survived or none of it did.
    const opens = (value.match(/\{/g) ?? []).length;
    const closes = (value.match(/\}/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it("ships the model output verbatim when enforcement is off", () => {
    const out = serializeLocaleResultDetailed(
      catalog,
      resultOf("de", [overflowing]),
      { enforceLayout: false },
    );
    const parsed = JSON.parse(out.file.contents) as { menu: { floor: string } };
    expect(parsed.menu.floor).toBe(overflowing.target);
    expect(out.clipped).toHaveLength(0);
  });

  it("leaves fitting entries untouched", () => {
    const fine = entry("menu.save", "Save", "Sichern", "de", "button");
    const out = serializeLocaleResultDetailed(catalog, resultOf("de", [fine]));
    expect(out.clipped).toHaveLength(0);
    const parsed = JSON.parse(out.file.contents) as { menu: { save: string } };
    expect(parsed.menu.save).toBe("Sichern");
  });
});

describe("serializeLocaleResult — degenerate translations", () => {
  const catalog = catalogOf();

  it("falls back to the source rather than shipping a blank string", () => {
    const blank = entry("menu.save", "Save", "", "de");
    const out = serializeLocaleResultDetailed(catalog, resultOf("de", [blank]));
    const parsed = JSON.parse(out.file.contents) as { menu: { save: string } };
    expect(parsed.menu.save).toBe("Save");
    expect(out.fellBack).toEqual(["menu.save"]);
  });

  it("keeps a legitimately empty translation of an empty source", () => {
    const empty = entry("menu.save", "", "", "de");
    const out = serializeLocaleResultDetailed(catalog, resultOf("de", [empty]));
    expect(out.fellBack).toEqual([]);
  });
});

describe("serializeLocaleResult — validation gate", () => {
  it("throws rather than emitting a file that lost a leaf", () => {
    // A non-finite number is representable in memory and not in JSON:
    // `JSON.stringify` turns it into `null`, which changes the leaf's type.
    const catalog: ExportCatalog = {
      fileName: "en.json",
      sourceLocale: "en",
      entries: [],
      tree: { count: Number.POSITIVE_INFINITY, label: "Save" },
      indent: "  ",
      trailingNewline: true,
      stats: {
        totalKeys: 2,
        translatableKeys: 1,
        skippedKeys: 1,
        totalCharacters: 4,
        maxDepth: 1,
      },
    } satisfies SourceCatalog & { tree: JsonValue };

    let thrown: unknown = null;
    try {
      serializeLocaleResult(catalog, resultOf("de", []));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ExportValidationError);
    const error = thrown as ExportValidationError;
    expect(error.locale).toBe("de");
    expect(error.path).toBe("de.json");
    expect(error.issues.length).toBeGreaterThan(0);
    expect(error.issues.every((i) => i.severity === "error")).toBe(true);
  });
});

describe("archives", () => {
  const catalog = catalogOf("{\n  \"menu\": {\n    \"save\": \"Save\"\n  }\n}\n");
  const results: LocaleResult[] = [
    resultOf("de", [entry("menu.save", "Save", "Sichern", "de")]),
    resultOf("ja", [entry("menu.save", "Save", "保存", "ja")]),
    resultOf("ar", [entry("menu.save", "Save", "حفظ", "ar")]),
  ];

  it("serialises every locale in order", () => {
    expect(serializeAllLocales(catalog, results).map((f) => f.path)).toEqual([
      "de.json",
      "ja.json",
      "ar.json",
    ]);
  });

  it("packs an archive that reads back with the right contents", () => {
    const archive = buildLocaleArchive(catalog, results, {
      directory: "public/locales",
      modifiedAt: new Date(2026, 0, 2, 3, 4, 5),
    });
    const back = readZip(archive.bytes);

    expect(back.map((f) => f.path)).toEqual([
      "public/locales/de.json",
      "public/locales/ja.json",
      "public/locales/ar.json",
    ]);
    expect(JSON.parse(back[1]?.contents ?? "{}")).toEqual({
      menu: { save: "保存" },
    });
    expect(back[0]?.contents.endsWith("\n")).toBe(true);
  });

  it("derives an archive name from the uploaded file", () => {
    expect(defaultArchiveName("en.json")).toBe("en-locales.zip");
    expect(defaultArchiveName("public/locales/en-US.json")).toBe(
      "en-US-locales.zip",
    );
    expect(defaultArchiveName("")).toBe("lingoloop-locales.zip");
  });
});
