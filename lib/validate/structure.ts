import { encodeKey } from "@/lib/core";
import type { Issue, JsonValue } from "@/lib/types";
import { classify, type IssueDetail } from "./errors";
import { codePoints, formatCodePoint } from "./text";

/**
 * Whole-file structural integrity.
 *
 * Quality bar #2 — "output JSON is structurally identical to input" — is a
 * guarantee, which means something has to actually *check* it rather than
 * trusting the rebuilder. These two functions are that check:
 *
 *   `assertStructuralParity` compares the rebuilt tree against the source tree.
 *   `validateEmittedJson`    re-reads the serialized bytes we are about to hand
 *                            the developer.
 *
 * The second is not redundant. The tree can be perfect and the *serializer*
 * still wrong (duplicate keys, a number that lost precision, a lone surrogate
 * that makes the file invalid UTF-8), and the developer would only find out
 * when their app fails to boot.
 */

export type JsonKind = "object" | "array" | "string" | "number" | "boolean" | "null";

export function jsonKind(value: JsonValue): JsonKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "object") return "object";
  if (t === "string") return "string";
  if (t === "number") return "number";
  return "boolean";
}

export interface ParityOptions {
  /**
   * Stop after this many divergences. A wholesale mismatch (wrong file
   * uploaded, provider returned prose) would otherwise produce one issue per
   * key and drown the UI.
   */
  maxIssues?: number;
  /**
   * Require identical key ordering. On by default: the promise is a diff that
   * shows only translated values, and a reordered object explodes that diff.
   */
  checkKeyOrder?: boolean;
}

const DEFAULT_MAX_ISSUES = 200;

/** Human-facing path: `root`, `menu.file`, `errors[0].title`. */
function displayPath(path: ReadonlyArray<string | number>): string {
  if (path.length === 0) return "(root)";
  return encodeKey(path);
}

function pathDetail(path: ReadonlyArray<string | number>): IssueDetail {
  return { path: displayPath(path) };
}

function structureIssue(
  path: ReadonlyArray<string | number>,
  message: string,
  extra: IssueDetail = {},
): Issue {
  const detail: IssueDetail = { ...pathDetail(path), ...extra };
  // File-level divergences (root, arrays) have no entry key; a divergence at a
  // named leaf does, and the review table uses it to scroll to the row.
  return path.length > 0
    ? classify("structure-mismatch", message, { key: encodeKey(path), detail })
    : classify("structure-mismatch", message, { detail });
}

/**
 * Deep-compare two JSON trees, ignoring string *values* (those are the
 * translation) but nothing else.
 *
 * Reported divergences: missing key, extra key, key reordering, type change,
 * array length change, and any mutated non-string leaf.
 */
export function assertStructuralParity(
  sourceTree: JsonValue,
  targetTree: JsonValue,
  options: ParityOptions = {},
): Issue[] {
  const maxIssues = options.maxIssues ?? DEFAULT_MAX_ISSUES;
  const checkKeyOrder = options.checkKeyOrder ?? true;
  const issues: Issue[] = [];
  let truncated = false;

  const push = (candidate: Issue): boolean => {
    if (issues.length >= maxIssues) {
      truncated = true;
      return false;
    }
    issues.push(candidate);
    return true;
  };

  const walk = (
    source: JsonValue,
    target: JsonValue,
    path: ReadonlyArray<string | number>,
  ): void => {
    if (truncated) return;

    const sourceKind = jsonKind(source);
    const targetKind = jsonKind(target);

    if (sourceKind !== targetKind) {
      push(
        structureIssue(
          path,
          `Type changed at ${displayPath(path)}: source is ${sourceKind}, output is ${targetKind}.`,
          { reason: "type-change", expected: sourceKind, actual: targetKind },
        ),
      );
      return; // children are meaningless once the shapes disagree
    }

    switch (sourceKind) {
      case "object": {
        walkObject(
          source as { [k: string]: JsonValue },
          target as { [k: string]: JsonValue },
          path,
        );
        return;
      }
      case "array": {
        walkArray(source as JsonValue[], target as JsonValue[], path);
        return;
      }
      case "string":
        // The one leaf that is *supposed* to change.
        return;
      default: {
        // Numbers, booleans and null are machine data: a translated `true` or a
        // rounded `3.5` is a corrupted config file.
        if (source !== target) {
          push(
            structureIssue(
              path,
              `Non-string leaf mutated at ${displayPath(path)}: ${JSON.stringify(source)} became ${JSON.stringify(target)}.`,
              {
                reason: "leaf-mutated",
                expected: JSON.stringify(source),
                actual: JSON.stringify(target),
              },
            ),
          );
        }
      }
    }
  };

  const walkObject = (
    source: { [k: string]: JsonValue },
    target: { [k: string]: JsonValue },
    path: ReadonlyArray<string | number>,
  ): void => {
    const sourceKeys = Object.keys(source);
    const targetKeys = Object.keys(target);
    const targetKeySet = new Set(targetKeys);

    for (const key of sourceKeys) {
      if (!targetKeySet.has(key)) {
        push(
          structureIssue([...path, key], `Key ${JSON.stringify(key)} is missing from the output.`, {
            reason: "missing-key",
            key,
          }),
        );
      }
    }
    const sourceKeySet = new Set(sourceKeys);
    for (const key of targetKeys) {
      if (!sourceKeySet.has(key)) {
        push(
          structureIssue(
            [...path, key],
            `Key ${JSON.stringify(key)} exists in the output but not in the source.`,
            { reason: "extra-key", key },
          ),
        );
      }
    }

    if (
      checkKeyOrder &&
      sourceKeys.length === targetKeys.length &&
      sourceKeys.every((k) => targetKeySet.has(k))
    ) {
      const firstDrift = sourceKeys.findIndex((k, i) => targetKeys[i] !== k);
      if (firstDrift >= 0) {
        push(
          structureIssue(
            path,
            `Key order changed at ${displayPath(path)}: expected ${JSON.stringify(sourceKeys[firstDrift])} at position ${firstDrift}, found ${JSON.stringify(targetKeys[firstDrift])}.`,
            {
              reason: "key-order",
              expected: sourceKeys[firstDrift] ?? null,
              actual: targetKeys[firstDrift] ?? null,
              position: firstDrift,
            },
          ),
        );
      }
    }

    for (const key of sourceKeys) {
      if (!targetKeySet.has(key)) continue;
      const sourceChild = source[key];
      const targetChild = target[key];
      if (sourceChild === undefined || targetChild === undefined) continue;
      walk(sourceChild, targetChild, [...path, key]);
      if (truncated) return;
    }
  };

  const walkArray = (
    source: JsonValue[],
    target: JsonValue[],
    path: ReadonlyArray<string | number>,
  ): void => {
    if (source.length !== target.length) {
      push(
        structureIssue(
          path,
          `Array length changed at ${displayPath(path)}: ${source.length} → ${target.length}.`,
          { reason: "array-length", expected: source.length, actual: target.length },
        ),
      );
    }
    const shared = Math.min(source.length, target.length);
    for (let i = 0; i < shared; i++) {
      const sourceChild = source[i];
      const targetChild = target[i];
      if (sourceChild === undefined || targetChild === undefined) continue;
      walk(sourceChild, targetChild, [...path, i]);
      if (truncated) return;
    }
  };

  walk(sourceTree, targetTree, []);

  if (truncated) {
    issues.push(
      classify(
        "structure-mismatch",
        `Structural comparison stopped after ${maxIssues} divergences — the output does not resemble the source document.`,
        { detail: { reason: "truncated", limit: maxIssues } },
      ),
    );
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Emitted JSON
// ---------------------------------------------------------------------------

interface TextScanFinding {
  kind: "duplicate-key" | "number-precision" | "lone-surrogate";
  message: string;
  detail: IssueDetail;
}

/**
 * A minimal JSON scanner that answers questions `JSON.parse` throws away.
 *
 * `JSON.parse` silently keeps the *last* of two duplicate keys and silently
 * rounds `10000000000000000001` to `10000000000000000000`. Both produce a file
 * that parses fine and is wrong. Detecting them needs the raw text, so this
 * walks it once: string literals are skipped correctly (escapes and all),
 * object depth is tracked to scope key names, and number literals are checked
 * for round-trip stability.
 */
function scanJsonText(text: string): TextScanFinding[] {
  const findings: TextScanFinding[] = [];
  const stack: Array<{ isObject: boolean; keys: Set<string> }> = [];
  let i = 0;
  let pendingKey: string | null = null;
  let expectingKey = false;

  const readString = (): { value: string; end: number } | null => {
    // Assumes text[i] === '"'.
    let out = "";
    let j = i + 1;
    while (j < text.length) {
      const ch = text[j];
      if (ch === undefined) break;
      if (ch === "\\") {
        const next = text[j + 1];
        if (next === undefined) return null;
        if (next === "u") {
          const hex = text.slice(j + 2, j + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
          out += String.fromCharCode(Number.parseInt(hex, 16));
          j += 6;
          continue;
        }
        const simple: Record<string, string> = {
          '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f",
          n: "\n", r: "\r", t: "\t",
        };
        const mapped = simple[next];
        if (mapped === undefined) return null;
        out += mapped;
        j += 2;
        continue;
      }
      if (ch === '"') return { value: out, end: j };
      out += ch;
      j += 1;
    }
    return null;
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === undefined) break;

    if (ch === '"') {
      const str = readString();
      if (str === null) break; // malformed; JSON.parse reports it properly
      if (expectingKey) {
        pendingKey = str.value;
        expectingKey = false;
      }
      i = str.end + 1;
      continue;
    }

    if (ch === "{") {
      stack.push({ isObject: true, keys: new Set() });
      expectingKey = true;
      i += 1;
      continue;
    }
    if (ch === "[") {
      stack.push({ isObject: false, keys: new Set() });
      expectingKey = false;
      i += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      stack.pop();
      expectingKey = false;
      pendingKey = null;
      i += 1;
      continue;
    }
    if (ch === ":") {
      const frame = stack[stack.length - 1];
      if (frame !== undefined && frame.isObject && pendingKey !== null) {
        if (frame.keys.has(pendingKey)) {
          findings.push({
            kind: "duplicate-key",
            message: `Duplicate key ${JSON.stringify(pendingKey)} in the emitted document — one of the two values is silently discarded when the file is loaded.`,
            detail: { reason: "duplicate-key", key: pendingKey },
          });
        }
        frame.keys.add(pendingKey);
      }
      pendingKey = null;
      i += 1;
      continue;
    }
    if (ch === ",") {
      const frame = stack[stack.length - 1];
      expectingKey = frame !== undefined && frame.isObject;
      i += 1;
      continue;
    }

    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      const literal = match?.[0];
      if (literal !== undefined && literal.length > 0) {
        checkNumberLiteral(literal, findings);
        i += literal.length;
        continue;
      }
    }

    i += 1;
  }

  return findings;
}

/**
 * A JSON number that does not survive `Number()` → `String()` unchanged has
 * already lost information the source file carried. `1e400` becomes
 * `Infinity`, which `JSON.stringify` then writes as `null`.
 */
function checkNumberLiteral(literal: string, findings: TextScanFinding[]): void {
  const parsed = Number(literal);
  if (!Number.isFinite(parsed)) {
    findings.push({
      kind: "number-precision",
      message: `Numeric literal ${literal} is not representable as a finite number and would be written back as null.`,
      detail: { reason: "number-not-finite", literal },
    });
    return;
  }
  // Only integer literals are compared verbatim. JSON forbids leading zeros
  // and a leading "+", so for integers the only way `String(Number(lit))` can
  // differ from `lit` is that IEEE-754 could not hold the value. Decimal and
  // exponent forms are skipped because `1.10` → `1.1` and `1e2` → `100` are
  // faithful re-spellings, not data loss. `-0` is the one benign exception.
  const canonical = String(parsed);
  if (literal !== "-0" && /^-?\d+$/.test(literal) && canonical !== literal) {
    findings.push({
      kind: "number-precision",
      message: `Integer literal ${literal} exceeds the exactly representable range and was rounded to ${canonical}.`,
      detail: { reason: "number-precision", literal, reserialized: canonical },
    });
  }
}

/** Unpaired surrogates make the emitted file invalid UTF-8. */
function findLoneSurrogate(text: string): number | null {
  const points = codePoints(text);
  for (const { cp } of points) {
    if (cp >= 0xd800 && cp <= 0xdfff) return cp;
  }
  return null;
}

/**
 * Structural equality for parsed JSON, used to prove a serialize→parse cycle
 * is lossless.
 */
export function deepEqualJson(a: JsonValue, b: JsonValue): boolean {
  const kindA = jsonKind(a);
  if (kindA !== jsonKind(b)) return false;
  if (kindA === "array") {
    const left = a as JsonValue[];
    const right = b as JsonValue[];
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
      const l = left[i];
      const r = right[i];
      if (l === undefined || r === undefined) return l === r;
      if (!deepEqualJson(l, r)) return false;
    }
    return true;
  }
  if (kindA === "object") {
    const left = a as { [k: string]: JsonValue };
    const right = b as { [k: string]: JsonValue };
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    // Key order is part of the contract, so compare positionally.
    for (let i = 0; i < leftKeys.length; i++) {
      const key = leftKeys[i];
      if (key === undefined || rightKeys[i] !== key) return false;
      const l = left[key];
      const r = right[key];
      if (l === undefined || r === undefined) return l === r;
      if (!deepEqualJson(l, r)) return false;
    }
    return true;
  }
  return a === b;
}

/**
 * Validate the bytes that are about to be downloaded.
 *
 * Checks, in order:
 *   1. it parses at all;
 *   2. it contains no lone surrogates (invalid UTF-8 once encoded);
 *   3. no object has duplicate keys and no number silently lost precision;
 *   4. serialize → parse round-trips to an identical structure;
 *   5. optionally, it is structurally identical to `expected`.
 *
 * Returns issues rather than throwing so the export UI can show every problem
 * at once.
 */
export function validateEmittedJson(
  text: string,
  expected?: JsonValue,
): Issue[] {
  const issues: Issue[] = [];

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text) as JsonValue;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      classify("invalid-json", `The emitted file is not valid JSON: ${message}`, {
        detail: { reason: "parse-failure", parserMessage: message, length: text.length },
      }),
    ];
  }

  const surrogate = findLoneSurrogate(text);
  if (surrogate !== null) {
    issues.push(
      classify(
        "invalid-json",
        `The emitted file contains an unpaired surrogate (${formatCodePoint(surrogate)}); the file cannot be encoded as valid UTF-8.`,
        { detail: { reason: "lone-surrogate", codePoint: formatCodePoint(surrogate) } },
      ),
    );
  }

  for (const finding of scanJsonText(text)) {
    const code = finding.kind === "duplicate-key" ? "structure-mismatch" : "invalid-json";
    issues.push(classify(code, finding.message, { detail: finding.detail }));
  }

  // Round trip: re-serialising and re-parsing must land on the same structure.
  let reparsed: JsonValue;
  try {
    reparsed = JSON.parse(JSON.stringify(parsed)) as JsonValue;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      ...issues,
      classify("invalid-json", `The emitted document does not survive re-serialisation: ${message}`, {
        detail: { reason: "round-trip-failure", parserMessage: message },
      }),
    ];
  }
  if (!deepEqualJson(parsed, reparsed)) {
    issues.push(
      classify(
        "invalid-json",
        "The emitted document does not round-trip: parsing and re-serialising it produces a different structure.",
        { detail: { reason: "round-trip-mismatch" } },
      ),
    );
  }

  if (expected !== undefined) {
    issues.push(...assertStructuralParity(expected, parsed));
  }

  return issues;
}
