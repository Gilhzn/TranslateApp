import { describe, expect, it } from "vitest";
import type { Issue, IssueCode, JsonValue } from "@/lib/types";
import {
  assertStructuralParity,
  deepEqualJson,
  jsonKind,
  validateEmittedJson,
} from "./structure";

function codes(issues: readonly Issue[]): IssueCode[] {
  return issues.map((i) => i.code);
}

function reasons(issues: readonly Issue[]): unknown[] {
  return issues.map((i) => i.detail?.reason);
}

const CATALOG: JsonValue = {
  app: { name: "Nebula Forge", version: 3, beta: true, tagline: null },
  menu: { file: { save: "Save", open: "Open" } },
  errors: [{ title: "Offline", retryAfter: 30 }, { title: "Rate limited", retryAfter: 60 }],
};

function translated(): JsonValue {
  return {
    app: { name: "Nebula Forge", version: 3, beta: true, tagline: null },
    menu: { file: { save: "Speichern", open: "Öffnen" } },
    errors: [
      { title: "Offline", retryAfter: 30 },
      { title: "Ratenbegrenzt", retryAfter: 60 },
    ],
  };
}

describe("jsonKind", () => {
  it("distinguishes null, array and object", () => {
    expect(jsonKind(null)).toBe("null");
    expect(jsonKind([])).toBe("array");
    expect(jsonKind({})).toBe("object");
    expect(jsonKind("x")).toBe("string");
    expect(jsonKind(1)).toBe("number");
    expect(jsonKind(false)).toBe("boolean");
  });
});

describe("assertStructuralParity", () => {
  it("accepts a tree where only string leaves changed", () => {
    expect(assertStructuralParity(CATALOG, translated())).toEqual([]);
  });

  it("accepts identical trees", () => {
    expect(assertStructuralParity(CATALOG, CATALOG)).toEqual([]);
  });

  it("reports a missing key with a precise path", () => {
    const target = translated() as { menu: { file: Record<string, JsonValue> } };
    delete target.menu.file.open;
    const issues = assertStructuralParity(CATALOG, target as JsonValue);
    expect(codes(issues)).toEqual(["structure-mismatch"]);
    expect(issues[0]?.detail?.path).toBe("menu.file.open");
    expect(issues[0]?.key).toBe("menu.file.open");
    expect(issues[0]?.detail?.reason).toBe("missing-key");
  });

  it("reports an extra key", () => {
    const target = translated() as { menu: { file: Record<string, JsonValue> } };
    target.menu.file.close = "Schließen";
    const issues = assertStructuralParity(CATALOG, target as JsonValue);
    expect(issues[0]?.detail?.reason).toBe("extra-key");
    expect(issues[0]?.detail?.path).toBe("menu.file.close");
  });

  it("reports key reordering, which would explode the developer's diff", () => {
    const target = {
      ...(translated() as Record<string, JsonValue>),
      menu: { file: { open: "Öffnen", save: "Speichern" } },
    } as JsonValue;
    const issues = assertStructuralParity(CATALOG, target);
    expect(issues[0]?.detail?.reason).toBe("key-order");
    expect(issues[0]?.detail?.expected).toBe("save");
    expect(issues[0]?.detail?.actual).toBe("open");
  });

  it("can be told to ignore key order", () => {
    const target = {
      ...(translated() as Record<string, JsonValue>),
      menu: { file: { open: "Öffnen", save: "Speichern" } },
    } as JsonValue;
    expect(
      assertStructuralParity(CATALOG, target, { checkKeyOrder: false }),
    ).toEqual([]);
  });

  it("reports a type change and does not descend past it", () => {
    const target = translated() as Record<string, JsonValue>;
    target.menu = "Menü";
    const issues = assertStructuralParity(CATALOG, target as JsonValue);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.detail?.reason).toBe("type-change");
    expect(issues[0]?.detail?.expected).toBe("object");
    expect(issues[0]?.detail?.actual).toBe("string");
  });

  it("reports an array length change", () => {
    const target = translated() as { errors: JsonValue[] };
    target.errors.pop();
    const issues = assertStructuralParity(CATALOG, target as JsonValue);
    expect(issues[0]?.detail?.reason).toBe("array-length");
    expect(issues[0]?.detail?.expected).toBe(2);
    expect(issues[0]?.detail?.actual).toBe(1);
  });

  it("reports a mutated number leaf with an array-index path", () => {
    const target = translated() as { errors: Array<Record<string, JsonValue>> };
    const first = target.errors[0];
    expect(first).toBeDefined();
    if (first) first.retryAfter = 45;
    const issues = assertStructuralParity(CATALOG, target as JsonValue);
    expect(issues[0]?.detail?.reason).toBe("leaf-mutated");
    expect(issues[0]?.detail?.path).toBe("errors[0].retryAfter");
    expect(issues[0]?.detail?.expected).toBe("30");
    expect(issues[0]?.detail?.actual).toBe("45");
  });

  it("reports a translated boolean and a translated null", () => {
    const target = translated() as { app: Record<string, JsonValue> };
    target.app.beta = false;
    target.app.tagline = "";
    const issues = assertStructuralParity(CATALOG, target as JsonValue);
    expect(reasons(issues)).toEqual(["leaf-mutated", "type-change"]);
  });

  it("labels a root-level divergence without inventing an entry key", () => {
    const issues = assertStructuralParity(CATALOG, []);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.key).toBeUndefined();
    expect(issues[0]?.detail?.path).toBe("(root)");
  });

  it("handles nested arrays of arrays", () => {
    const source: JsonValue = { grid: [["a", "b"], ["c"]] };
    const good: JsonValue = { grid: [["x", "y"], ["z"]] };
    const bad: JsonValue = { grid: [["x", "y"], ["z", "w"]] };
    expect(assertStructuralParity(source, good)).toEqual([]);
    expect(assertStructuralParity(source, bad)[0]?.detail?.path).toBe("grid[1]");
  });

  it("caps runaway divergence and says so", () => {
    const source: Record<string, JsonValue> = {};
    for (let i = 0; i < 50; i++) source[`k${i}`] = `v${i}`;
    const issues = assertStructuralParity(source as JsonValue, {}, { maxIssues: 5 });
    expect(issues).toHaveLength(6);
    expect(issues[5]?.detail?.reason).toBe("truncated");
  });

  it("survives keys containing dots and brackets", () => {
    const source: JsonValue = { "app.name": { "items[]": "Items" } };
    const target: JsonValue = { "app.name": {} };
    const issues = assertStructuralParity(source, target);
    expect(issues[0]?.detail?.path).toBe("app\\.name.items\\[\\]");
  });
});

describe("deepEqualJson", () => {
  it("compares structurally, including key order", () => {
    expect(deepEqualJson({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(deepEqualJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
    expect(deepEqualJson([1, 2], [1, 2])).toBe(true);
    expect(deepEqualJson([1, 2], [2, 1])).toBe(false);
    expect(deepEqualJson(null, 0)).toBe(false);
    expect(deepEqualJson({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
  });
});

describe("validateEmittedJson", () => {
  it("accepts a faithful serialization", () => {
    const text = JSON.stringify(translated(), null, 2);
    expect(validateEmittedJson(text, CATALOG)).toEqual([]);
  });

  it("accepts valid JSON with no expectation to compare against", () => {
    expect(validateEmittedJson('{"a":1,"b":[true,null]}')).toEqual([]);
  });

  it("reports unparseable output", () => {
    const issues = validateEmittedJson('{"a": }');
    expect(codes(issues)).toEqual(["invalid-json"]);
    expect(issues[0]?.detail?.reason).toBe("parse-failure");
  });

  it("reports a trailing comma", () => {
    expect(codes(validateEmittedJson('{"a":1,}'))).toEqual(["invalid-json"]);
  });

  it("detects duplicate keys that JSON.parse silently swallows", () => {
    const issues = validateEmittedJson('{"save":"Speichern","save":"Sichern"}');
    expect(codes(issues)).toEqual(["structure-mismatch"]);
    expect(issues[0]?.detail?.key).toBe("save");
  });

  it("does not confuse a repeated key in a sibling object for a duplicate", () => {
    expect(validateEmittedJson('{"a":{"save":1},"b":{"save":2}}')).toEqual([]);
  });

  it("does not treat string values that look like keys as keys", () => {
    expect(validateEmittedJson('{"a":"b","c":"a"}')).toEqual([]);
  });

  it("handles escaped quotes inside strings", () => {
    expect(validateEmittedJson('{"a":"say \\"hi\\"","b":"x"}')).toEqual([]);
  });

  it("handles arrays of objects", () => {
    expect(validateEmittedJson('[{"a":1},{"a":2}]')).toEqual([]);
  });

  it("flags a numeric literal that lost precision", () => {
    const issues = validateEmittedJson('{"id": 12345678901234567890}');
    expect(codes(issues)).toEqual(["invalid-json"]);
    expect(issues[0]?.detail?.reason).toBe("number-precision");
  });

  it("flags a numeric literal that overflows to Infinity", () => {
    const issues = validateEmittedJson('{"n": 1e400}');
    expect(issues[0]?.detail?.reason).toBe("number-not-finite");
  });

  it("accepts benign numeric spellings", () => {
    expect(validateEmittedJson('{"a":1.0,"b":1e2,"c":-0,"d":-42,"e":0.5}')).toEqual([]);
  });

  it("flags a lone surrogate that would break UTF-8 encoding", () => {
    const issues = validateEmittedJson('{"a":"broken \ud800 pair"}');
    expect(codes(issues)).toContain("invalid-json");
    expect(issues[0]?.detail?.reason).toBe("lone-surrogate");
  });

  it("reports structural divergence against the expected tree", () => {
    const broken = translated() as { menu: { file: Record<string, JsonValue> } };
    delete broken.menu.file.save;
    const issues = validateEmittedJson(JSON.stringify(broken), CATALOG);
    expect(codes(issues)).toEqual(["structure-mismatch"]);
    expect(issues[0]?.detail?.path).toBe("menu.file.save");
  });

  it("catches a serializer that reordered keys", () => {
    const text = '{"menu":{"file":{"open":"Öffnen","save":"Speichern"}}}';
    const source: JsonValue = { menu: { file: { save: "Save", open: "Open" } } };
    const issues = validateEmittedJson(text, source);
    expect(issues[0]?.detail?.reason).toBe("key-order");
  });

  it("accepts an indented file with a trailing newline", () => {
    const text = `${JSON.stringify(translated(), null, "\t")}\n`;
    expect(validateEmittedJson(text, CATALOG)).toEqual([]);
  });
});
