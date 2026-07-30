import { describe, expect, it } from "vitest";
import { PipelineRequestError } from "./errors";
import {
  MAX_REQUEST_BYTES,
  MAX_TARGET_LOCALES,
  parseSettings,
  parseTranslateRequest,
  readJsonBody,
} from "./request";

const VALID_SETTINGS = {
  sourceLocale: "en",
  targetLocales: ["de", "pt-BR"],
  tone: "gaming",
  productContext: "A roguelike deckbuilder.",
  glossary: [],
  enforceLayout: true,
  maxRepairAttempts: 2,
};

function jsonRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/api/translate", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function expectRejection(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<PipelineRequestError> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PipelineRequestError);
  const failure = caught as PipelineRequestError;
  expect(failure.status).toBe(status);
  expect(failure.code).toBe(code);
  return failure;
}

describe("readJsonBody", () => {
  it("parses a well-formed JSON body", async () => {
    await expect(readJsonBody(jsonRequest({ a: 1 }))).resolves.toEqual({ a: 1 });
  });

  it("refuses a non-JSON content type", async () => {
    await expectRejection(
      readJsonBody(
        new Request("https://example.test/api/translate", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        }),
      ),
      415,
      "unsupported-media-type",
    );
  });

  it("refuses an oversized body declared by Content-Length", async () => {
    await expectRejection(
      readJsonBody(
        jsonRequest({ a: 1 }, { "content-length": String(MAX_REQUEST_BYTES + 1) }),
      ),
      413,
      "payload-too-large",
    );
  });

  it("refuses an oversized body that lies about its length", async () => {
    const big = JSON.stringify({ text: "x".repeat(5_000) });
    await expectRejection(readJsonBody(jsonRequest(big), 1_000), 413, "payload-too-large");
  });

  it("reports malformed JSON as a 400, not a crash", async () => {
    await expectRejection(readJsonBody(jsonRequest("{ not json")), 400, "invalid-json");
  });

  it("reports an empty body as a 400", async () => {
    await expectRejection(readJsonBody(jsonRequest("   ")), 400, "invalid-json");
  });
});

describe("parseSettings", () => {
  it("accepts a well-formed settings object", () => {
    const settings = parseSettings(VALID_SETTINGS);
    expect(settings.targetLocales).toEqual(["de", "pt-BR"]);
    expect(settings.tone).toBe("gaming");
    expect(settings.glossary).toEqual([]);
  });

  it("de-duplicates target locales", () => {
    expect(
      parseSettings({ ...VALID_SETTINGS, targetLocales: ["de", "de", "fr"] })
        .targetLocales,
    ).toEqual(["de", "fr"]);
  });

  it.each([
    ["settings.sourceLocale", { sourceLocale: 42 }],
    ["settings.sourceLocale", { sourceLocale: "not a locale!" }],
    ["settings.targetLocales", { targetLocales: [] }],
    ["settings.targetLocales", { targetLocales: "de" }],
    [
      "settings.targetLocales",
      { targetLocales: Array.from({ length: MAX_TARGET_LOCALES + 1 }, () => "de") },
    ],
    ["settings.tone", { tone: "sarcastic" }],
    ["settings.enforceLayout", { enforceLayout: "yes" }],
    ["settings.maxRepairAttempts", { maxRepairAttempts: 99 }],
    ["settings.maxRepairAttempts", { maxRepairAttempts: 1.5 }],
    ["settings.maxRepairAttempts", { maxRepairAttempts: -1 }],
    ["settings.glossary", { glossary: {} }],
  ])("rejects a bad %s", (field, override) => {
    let caught: unknown = null;
    try {
      parseSettings({ ...VALID_SETTINGS, ...override });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PipelineRequestError);
    expect((caught as PipelineRequestError).field).toBe(field);
    expect((caught as PipelineRequestError).status).toBe(400);
  });

  it("validates glossary rows down to the locale keys", () => {
    const settings = parseSettings({
      ...VALID_SETTINGS,
      glossary: [
        { term: "Ember", translations: {}, caseSensitive: true, note: "brand" },
        { term: "Deck", translations: { de: "Deck" }, caseSensitive: false },
      ],
    });
    expect(settings.glossary).toHaveLength(2);
    expect(settings.glossary[0]?.note).toBe("brand");

    expect(() =>
      parseSettings({
        ...VALID_SETTINGS,
        glossary: [{ term: "X", translations: { "de de": "Y" }, caseSensitive: false }],
      }),
    ).toThrow(PipelineRequestError);
  });

  it("rejects a settings value that is not an object", () => {
    expect(() => parseSettings("de")).toThrow(PipelineRequestError);
    expect(() => parseSettings(null)).toThrow(PipelineRequestError);
    expect(() => parseSettings([VALID_SETTINGS])).toThrow(PipelineRequestError);
  });
});

describe("parseTranslateRequest", () => {
  it("parses the source file server-side", () => {
    const parsed = parseTranslateRequest({
      fileName: "en.json",
      text: '{\r\n\t"menu": {\r\n\t\t"save": "Save"\r\n\t}\r\n}\r\n',
      settings: VALID_SETTINGS,
    });

    expect(parsed.catalog.fileName).toBe("en.json");
    expect(parsed.catalog.entries.map((e) => e.key)).toEqual(["menu.save"]);
    // Formatting facts the client never has to be trusted with.
    expect(parsed.catalog.indent).toBe("\t");
    expect(parsed.catalog.eol).toBe("\r\n");
    expect(parsed.catalog.keyOrder.size).toBeGreaterThan(0);
  });

  it("uses the settings source locale for the catalog", () => {
    const parsed = parseTranslateRequest({
      text: '{"a":"A"}',
      settings: { ...VALID_SETTINGS, sourceLocale: "fr" },
    });
    expect(parsed.catalog.sourceLocale).toBe("fr");
  });

  it("turns a broken source file into a 400 with line and column", () => {
    let caught: unknown = null;
    try {
      parseTranslateRequest({
        fileName: "en.json",
        text: '{\n  "a": 1,\n  "b" 2\n}\n',
        settings: VALID_SETTINGS,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PipelineRequestError);
    const failure = caught as PipelineRequestError;
    expect(failure.status).toBe(400);
    expect(failure.code).toBe("source-parse-failed");
    expect(failure.detail?.["line"]).toBe(3);
    expect(failure.toBody().error.field).toBe("text");
  });

  it("rejects a missing or non-string text field", () => {
    expect(() => parseTranslateRequest({ settings: VALID_SETTINGS })).toThrow(
      PipelineRequestError,
    );
    expect(() =>
      parseTranslateRequest({ text: { a: 1 }, settings: VALID_SETTINGS }),
    ).toThrow(PipelineRequestError);
  });

  it("rejects a body that is not an object", () => {
    expect(() => parseTranslateRequest("hello")).toThrow(PipelineRequestError);
    expect(() => parseTranslateRequest(null)).toThrow(PipelineRequestError);
  });

  it("rejects an oversized file name", () => {
    expect(() =>
      parseTranslateRequest({
        fileName: "a".repeat(500),
        text: '{"a":"A"}',
        settings: VALID_SETTINGS,
      }),
    ).toThrow(PipelineRequestError);
  });

  it("serialises to a body that never echoes the payload back", () => {
    const failure = new PipelineRequestError(400, "invalid-body", "Bad field.", {
      field: "settings.tone",
    });
    expect(failure.toBody()).toEqual({
      error: { code: "invalid-body", message: "Bad field.", field: "settings.tone" },
    });
  });
});
