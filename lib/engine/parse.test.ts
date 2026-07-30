import { describe, expect, it } from "vitest";

import {
  extractJson,
  parseProviderOutput,
  stripTrailingCommas,
  stripWrapper,
} from "./parse";

const CLEAN = '{"translations":[{"key":"a","target":"Speichern"}]}';

describe("parseProviderOutput", () => {
  it("parses the happy path", () => {
    const { translations, issues } = parseProviderOutput(CLEAN);
    expect(translations).toEqual([{ key: "a", target: "Speichern" }]);
    expect(issues).toEqual([]);
  });

  it("keeps a rationale and trims it, dropping empty ones", () => {
    const { translations } = parseProviderOutput(
      '{"translations":[{"key":"a","target":"OK","rationale":"  short form  "},{"key":"b","target":"Nein","rationale":"  "}]}',
    );
    expect(translations[0]?.rationale).toBe("short form");
    expect(translations[1]).not.toHaveProperty("rationale");
  });

  describe("tolerance", () => {
    it("strips markdown fences", () => {
      const raw = "Sure, here you go:\n\n```json\n" + CLEAN + "\n```\n\nLet me know!";
      expect(parseProviderOutput(raw).translations).toHaveLength(1);
    });

    it("strips an unterminated fence", () => {
      expect(parseProviderOutput("```json\n" + CLEAN).translations).toHaveLength(1);
    });

    it("finds the outermost object inside prose", () => {
      const raw = `I translated these strings. ${CLEAN} Hope that helps.`;
      expect(parseProviderOutput(raw).translations).toHaveLength(1);
    });

    it("recovers from trailing commas", () => {
      const raw = '{"translations":[{"key":"a","target":"Speichern",},],}';
      expect(parseProviderOutput(raw).translations).toEqual([
        { key: "a", target: "Speichern" },
      ]);
    });

    it("accepts a bare array", () => {
      const raw = '[{"key":"a","target":"Speichern"},{"key":"b","target":"Abbrechen"}]';
      expect(parseProviderOutput(raw).translations).toHaveLength(2);
    });

    it("accepts a single bare object", () => {
      expect(parseProviderOutput('{"key":"a","target":"Speichern"}').translations).toEqual([
        { key: "a", target: "Speichern" },
      ]);
    });

    it("accepts a flat key/value map", () => {
      const { translations } = parseProviderOutput('{"a":"Speichern","b":"Abbrechen"}');
      expect(translations).toEqual([
        { key: "a", target: "Speichern" },
        { key: "b", target: "Abbrechen" },
      ]);
    });

    it("accepts common field aliases", () => {
      const { translations } = parseProviderOutput(
        '{"results":[{"id":"a","translation":"Speichern","reason":"shorter"}]}',
      );
      expect(translations).toEqual([
        { key: "a", target: "Speichern", rationale: "shorter" },
      ]);
    });

    it("does not mistake a brace inside a translated string for the end of the object", () => {
      const raw = '{"translations":[{"key":"a","target":"Es gibt {count} } Objekte"}]}';
      expect(parseProviderOutput(raw).translations[0]?.target).toBe(
        "Es gibt {count} } Objekte",
      );
    });

    it("recovers what it can from a truncated response", () => {
      const raw = '{"translations":[{"key":"a","target":"Speichern"},{"key":"b","targ';
      const { translations } = parseProviderOutput(raw);
      expect(translations).toEqual([{ key: "a", target: "Speichern" }]);
    });

    it("keeps an empty target, which is a legitimate answer", () => {
      expect(parseProviderOutput('[{"key":"a","target":""}]').translations).toEqual([
        { key: "a", target: "" },
      ]);
    });
  });

  describe("never throws", () => {
    const garbage = [
      "",
      "   ",
      "I'm sorry, I can't help with that.",
      "{",
      "}{",
      "null",
      "[[[",
      '{"translations": "not an array"}',
      '{"translations":[1,2,3]}',
      "```json\n```",
    ];

    for (const raw of garbage) {
      it(`survives ${JSON.stringify(raw)}`, () => {
        const result = parseProviderOutput(raw);
        expect(Array.isArray(result.translations)).toBe(true);
        expect(result.issues.every((issue) => issue.code === "provider-error")).toBe(true);
      });
    }

    it("reports an empty response as a provider error", () => {
      const { issues } = parseProviderOutput("");
      expect(issues[0]?.code).toBe("provider-error");
      expect(issues[0]?.message).toMatch(/empty response/i);
    });

    it("reports unparseable output as a provider error with a preview", () => {
      const { issues } = parseProviderOutput("I cannot translate this content.");
      expect(issues[0]?.severity).toBe("error");
      expect(issues[0]?.detail?.preview).toBeDefined();
    });

    it("reports an unrecognised JSON shape", () => {
      const { issues } = parseProviderOutput('{"foo": 1, "bar": 2}');
      expect(issues[0]?.message).toMatch(/unrecognised shape/i);
    });
  });

  describe("entry hygiene", () => {
    it("drops malformed entries and reports how many", () => {
      const raw =
        '{"translations":[{"key":"a","target":"Speichern"},{"key":"b"},{"target":"x"},null,42]}';
      const { translations, issues } = parseProviderOutput(raw);
      expect(translations).toHaveLength(1);
      expect(issues[0]?.detail?.droppedEntries).toBe(4);
      expect(issues[0]?.severity).toBe("warning");
    });

    it("keeps the first of a duplicated key", () => {
      const raw = '[{"key":"a","target":"first"},{"key":"a","target":"second"}]';
      const { translations, issues } = parseProviderOutput(raw);
      expect(translations).toEqual([{ key: "a", target: "first" }]);
      expect(issues[0]?.severity).toBe("info");
    });
  });

  describe("key reconciliation", () => {
    it("drops keys that were not requested", () => {
      const raw = '[{"key":"a","target":"A"},{"key":"ghost","target":"?"}]';
      const { translations, issues } = parseProviderOutput(raw, { expectedKeys: ["a"] });
      expect(translations.map((t) => t.key)).toEqual(["a"]);
      expect(issues.some((issue) => /not requested/.test(issue.message))).toBe(true);
    });

    it("reports each missing key individually so the loop can retry it", () => {
      const raw = '[{"key":"a","target":"A"}]';
      const { issues } = parseProviderOutput(raw, { expectedKeys: ["a", "b", "c"] });
      const missing = issues.filter((issue) => issue.key !== undefined);
      expect(missing.map((issue) => issue.key)).toEqual(["b", "c"]);
      expect(missing.every((issue) => issue.severity === "error")).toBe(true);
    });

    it("reports every key as missing when the response is unusable", () => {
      const { issues } = parseProviderOutput("nonsense", { expectedKeys: ["a", "b"] });
      expect(issues.filter((issue) => issue.key !== undefined)).toHaveLength(2);
    });

    it("is silent when everything requested came back", () => {
      const { issues } = parseProviderOutput(CLEAN, { expectedKeys: ["a"] });
      expect(issues).toEqual([]);
    });
  });
});

describe("stripWrapper", () => {
  it("prefers the fenced block that actually contains JSON", () => {
    const raw = "```\nnot json\n```\n```json\n{\"a\":1}\n```";
    expect(stripWrapper(raw)).toBe('{"a":1}');
  });

  it("removes a byte order mark", () => {
    expect(stripWrapper("﻿{\"a\":1}")).toBe('{"a":1}');
  });

  it("leaves bare JSON alone", () => {
    expect(stripWrapper(" {\"a\":1} ")).toBe('{"a":1}');
  });
});

describe("stripTrailingCommas", () => {
  it("removes commas before closers", () => {
    expect(stripTrailingCommas('{"a":[1,2,],}')).toBe('{"a":[1,2]}');
  });

  it("leaves commas inside strings alone", () => {
    expect(stripTrailingCommas('{"a":"x, ]"}')).toBe('{"a":"x, ]"}');
  });

  it("leaves escaped quotes intact", () => {
    const input = '{"a":"say \\" , ]"}';
    expect(stripTrailingCommas(input)).toBe(input);
  });
});

describe("extractJson", () => {
  it("returns undefined when there is no structural character", () => {
    expect(extractJson("hello")).toBeUndefined();
  });

  it("picks whichever of { or [ comes first", () => {
    expect(extractJson('prefix [1,2] {"a":1}')).toEqual([1, 2]);
  });
});
