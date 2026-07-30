import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Issue, IssueCode } from "@/lib/types";
import {
  ALL_ISSUE_CODES,
  LingoLoopError,
  ProviderError,
  SEVERITY_POLICY,
  SourceParseError,
  StructureError,
  ValidationError,
  classify,
  compareSeverity,
  defaultSeverity,
  isLingoLoopError,
  issue,
  maxSeverity,
  summarizeIssues,
  toIssue,
} from "./errors";

/**
 * Re-derive the `IssueCode` union from the contract source.
 *
 * A type-level check would be invisible to `vitest run`; reading the file makes
 * "someone added a code to lib/types.ts and forgot the severity policy" a red
 * test, which is the failure mode this guards against.
 */
function issueCodesFromContract(): string[] {
  const path = fileURLToPath(new URL("../types.ts", import.meta.url));
  const source = readFileSync(path, "utf8");
  const start = source.indexOf("export type IssueCode =");
  if (start < 0) throw new Error("IssueCode union not found in lib/types.ts");
  const end = source.indexOf(";", start);
  if (end < 0) throw new Error("IssueCode union is unterminated in lib/types.ts");
  const body = source.slice(start, end);
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("severity policy", () => {
  it("classifies every IssueCode declared in the domain contract", () => {
    const declared = issueCodesFromContract();
    expect(declared.length).toBeGreaterThan(0);
    for (const code of declared) {
      expect(
        Object.prototype.hasOwnProperty.call(SEVERITY_POLICY, code),
        `IssueCode "${code}" has no entry in SEVERITY_POLICY`,
      ).toBe(true);
    }
  });

  it("does not classify codes that the contract no longer declares", () => {
    const declared = new Set(issueCodesFromContract());
    for (const code of ALL_ISSUE_CODES) {
      expect(declared.has(code), `SEVERITY_POLICY has stale code "${code}"`).toBe(true);
    }
  });

  it("exposes exactly one severity per code", () => {
    for (const code of ALL_ISSUE_CODES) {
      expect(["error", "warning", "info"]).toContain(defaultSeverity(code));
    }
  });

  it("keeps placeholder-reordered at info so grammar-driven reordering is legal", () => {
    expect(defaultSeverity("placeholder-reordered")).toBe("info");
  });

  it("treats placeholder loss and overflow as errors", () => {
    expect(defaultSeverity("placeholder-missing")).toBe("error");
    expect(defaultSeverity("placeholder-added")).toBe("error");
    expect(defaultSeverity("placeholder-malformed")).toBe("error");
    expect(defaultSeverity("length-overflow")).toBe("error");
    expect(defaultSeverity("structure-mismatch")).toBe("error");
  });
});

describe("issue()", () => {
  it("omits optional fields rather than setting them undefined", () => {
    const result = issue("untranslated", "warning", "identical");
    expect(Object.keys(result).sort()).toEqual(["code", "message", "severity"]);
  });

  it("carries key and detail through", () => {
    const result = issue("length-tight", "warning", "snug", {
      key: "menu.save",
      detail: { overBy: 2 },
    });
    expect(result.key).toBe("menu.save");
    expect(result.detail).toEqual({ overBy: 2 });
  });

  it("classify() uses the policy severity", () => {
    expect(classify("casing-drift", "x").severity).toBe("info");
    expect(classify("empty-translation", "x").severity).toBe("error");
  });
});

describe("summarizeIssues", () => {
  const sample: Issue[] = [
    { code: "casing-drift", severity: "info", message: "a" },
    { code: "whitespace-drift", severity: "warning", message: "b" },
    { code: "placeholder-missing", severity: "error", message: "c" },
    { code: "placeholder-added", severity: "error", message: "d" },
    { code: "whitespace-drift", severity: "warning", message: "e" },
  ];

  it("counts by severity and by code", () => {
    const summary = summarizeIssues(sample);
    expect(summary.total).toBe(5);
    expect(summary.errors).toBe(2);
    expect(summary.warnings).toBe(2);
    expect(summary.infos).toBe(1);
    expect(summary.byCode["whitespace-drift"]).toBe(2);
    expect(summary.byCode["placeholder-missing"]).toBe(1);
    expect(summary.byCode["length-overflow"]).toBeUndefined();
  });

  it("returns the first issue at the highest severity as the headline", () => {
    const summary = summarizeIssues(sample);
    expect(summary.mostSevere).toBe("error");
    expect(summary.headline?.message).toBe("c");
  });

  it("handles an empty list", () => {
    const summary = summarizeIssues([]);
    expect(summary).toMatchObject({
      total: 0,
      errors: 0,
      warnings: 0,
      infos: 0,
      mostSevere: null,
      headline: null,
    });
    expect(maxSeverity([])).toBeNull();
  });

  it("orders severities error > warning > info", () => {
    expect(compareSeverity("error", "warning")).toBeGreaterThan(0);
    expect(compareSeverity("warning", "info")).toBeGreaterThan(0);
    expect(compareSeverity("info", "info")).toBe(0);
  });
});

describe("error classes", () => {
  it("LingoLoopError carries a code and converts to an Issue", () => {
    const error = new LingoLoopError("provider-error", "boom", {
      key: "a.b",
      detail: { status: 500 },
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.severity).toBe("error");
    expect(error.toIssue()).toEqual({
      code: "provider-error",
      severity: "error",
      message: "boom",
      key: "a.b",
      detail: { status: 500 },
    });
  });

  it("respects a severity override", () => {
    const error = new LingoLoopError("provider-error", "soft", { severity: "warning" });
    expect(error.toIssue().severity).toBe("warning");
  });

  it("subclasses pin their code and name", () => {
    expect(new SourceParseError("bad json").code).toBe("invalid-json");
    expect(new SourceParseError("bad json").name).toBe("SourceParseError");
    expect(new ProviderError("429").code).toBe("provider-error");
    expect(new ProviderError("429", { retryable: true }).retryable).toBe(true);
    expect(new ProviderError("429").retryable).toBe(false);
    expect(new ValidationError("tag-imbalance", "unclosed").code).toBe("tag-imbalance");
    expect(new StructureError("menu.file", "missing").code).toBe("structure-mismatch");
  });

  it("StructureError puts its path in the detail payload", () => {
    const error = new StructureError("errors[0].title", "missing key", {
      detail: { reason: "missing-key" },
    });
    expect(error.path).toBe("errors[0].title");
    expect(error.toIssue().detail).toEqual({
      path: "errors[0].title",
      reason: "missing-key",
    });
  });

  it("preserves the cause chain", () => {
    const root = new Error("socket hang up");
    const error = new ProviderError("request failed", { cause: root });
    expect(error.cause).toBe(root);
  });

  it("isLingoLoopError narrows correctly", () => {
    expect(isLingoLoopError(new ProviderError("x"))).toBe(true);
    expect(isLingoLoopError(new Error("x"))).toBe(false);
    expect(isLingoLoopError("x")).toBe(false);
  });
});

describe("toIssue", () => {
  it("passes LingoLoopError through with its own code", () => {
    const result = toIssue(new SourceParseError("unexpected token"));
    expect(result.code).toBe("invalid-json");
    expect(result.message).toBe("unexpected token");
  });

  it("merges caller detail over the error's own", () => {
    const error = new ProviderError("nope", { detail: { attempt: 1 } });
    const result = toIssue(error, "provider-error", { key: "x", detail: { attempt: 2 } });
    expect(result.detail).toEqual({ attempt: 2 });
    expect(result.key).toBe("x");
  });

  it("normalises plain Errors", () => {
    const result = toIssue(new TypeError("fetch failed"));
    expect(result.code).toBe("provider-error");
    expect(result.message).toBe("fetch failed");
    expect(result.detail?.errorName).toBe("TypeError");
  });

  it("normalises non-Error throwables without producing [object Object]", () => {
    expect(toIssue("rate limited").message).toBe("rate limited");
    expect(toIssue({ status: 503 }).message).toContain("503");
    expect(toIssue(null).message).toContain("null");
    expect(toIssue(undefined).message).toContain("undefined");
  });

  it("honours a custom fallback code", () => {
    const code: IssueCode = "budget-exhausted";
    expect(toIssue(new Error("gave up"), code).code).toBe(code);
  });
});
