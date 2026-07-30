import { describe, expect, it } from "vitest";
import { extractPlaceholders } from "@/lib/core";
import type { Issue, IssueCode, TranslationUnit } from "@/lib/types";
import {
  parseAngleTag,
  placeholderIdentity,
  validatePlaceholderParity,
  validateString,
  type ValidationContext,
} from "./validators";
import { applyMechanicalFixes } from "./mechanical-fix";
import { buildRepairFeedback, needsRepair, resolveFinalStatus } from "./repair";

/**
 * Angle-tag ATTRIBUTE parity.
 *
 * The regression this file exists to prevent: a translation that rewrites,
 * drops, empties, swaps or injects a tag attribute used to validate 100% clean
 * and ship as `passed`, because placeholder identity was the element name
 * alone. A link whose destination silently changed is a 404 in production —
 * the loudest possible corruption — so every case below asserts the *shipped
 * status*, not just the issue list.
 */

const CTX: ValidationContext = {
  key: "legal.terms",
  locale: "de",
  sourceLocale: "en",
  role: "body",
};

const SOURCE =
  'Read our <a href="/terms">terms</a> and <a href="/privacy">privacy policy</a>.';

function codes(issues: readonly Issue[]): IssueCode[] {
  return issues.map((i) => i.code);
}

function attributeIssues(issues: readonly Issue[]): Issue[] {
  return issues.filter(
    (i) =>
      i.code === "placeholder-malformed" &&
      typeof i.detail?.["attribute"] === "string",
  );
}

/** The full pipeline an entry goes through, ending at its terminal status. */
function ship(
  source: string,
  target: string,
  ctx: ValidationContext = CTX,
): { issues: Issue[]; status: string; repair: boolean } {
  const fixed = applyMechanicalFixes(source, target).text;
  const issues = validateString(source, fixed, ctx);
  return {
    issues,
    status: resolveFinalStatus(issues, null),
    repair: needsRepair(issues, null),
  };
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

describe("parseAngleTag", () => {
  it("reads a double-quoted attribute", () => {
    const shape = parseAngleTag('<a href="/terms">');
    expect(shape).not.toBeNull();
    expect(shape?.name).toBe("a");
    expect(shape?.closing).toBe(false);
    expect(shape?.selfClosing).toBe(false);
    expect([...(shape?.attributes ?? [])]).toEqual([["href", "/terms"]]);
  });

  it("reads single-quoted and unquoted values identically", () => {
    expect([...(parseAngleTag("<a href='/terms'>")?.attributes ?? [])]).toEqual([
      ["href", "/terms"],
    ]);
    expect([...(parseAngleTag("<a href=/terms>")?.attributes ?? [])]).toEqual([
      ["href", "/terms"],
    ]);
  });

  it("treats a valueless boolean attribute as an empty value", () => {
    const shape = parseAngleTag("<input disabled>");
    expect([...(shape?.attributes ?? [])]).toEqual([["disabled", ""]]);
  });

  it("lowercases attribute names but not values", () => {
    const shape = parseAngleTag('<a HREF="/Terms" Data-Id="X">');
    expect([...(shape?.attributes ?? [])]).toEqual([
      ["href", "/Terms"],
      ["data-id", "X"],
    ]);
  });

  it("handles quotes inside the other quote style", () => {
    const shape = parseAngleTag(`<b title='He said "hi"'>`);
    expect(shape?.attributes.get("title")).toBe('He said "hi"');
  });

  it("detects self-closing and closing forms", () => {
    expect(parseAngleTag('<img src="/logo.png"/>')?.selfClosing).toBe(true);
    expect(parseAngleTag("<br />")?.selfClosing).toBe(true);
    expect(parseAngleTag("</a>")?.closing).toBe(true);
    expect(parseAngleTag("<0>")?.name).toBe("0");
  });

  it("returns null for something that is not a tag", () => {
    expect(parseAngleTag("{count}")).toBeNull();
    expect(parseAngleTag("<")).toBeNull();
  });

  it("keeps multiple attributes and ignores redundant whitespace", () => {
    const shape = parseAngleTag('<a   href = "/t"    target="_blank"  >');
    expect([...(shape?.attributes ?? [])]).toEqual([
      ["href", "/t"],
      ["target", "_blank"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe("placeholderIdentity with attributes", () => {
  function idOf(value: string): string {
    const [p] = extractPlaceholders(value);
    expect(p).toBeDefined();
    return placeholderIdentity(p!);
  }

  it("includes normalised attributes for an opening tag", () => {
    expect(idOf('<a href="/terms">')).toBe('angle:a[href="/terms"]');
  });

  it("separates two links that differ only by href", () => {
    expect(idOf('<a href="/terms">')).not.toBe(idOf('<a href="/privacy">'));
  });

  it("is unchanged for plain, index and closing tags", () => {
    // react-i18next <Trans> catalogues must keep their exact old behaviour.
    expect(idOf("<b>")).toBe("angle:b");
    expect(idOf("<0>")).toBe("angle:0");
    expect(idOf("</a>")).toBe("angle:/a");
    expect(idOf("<br/>")).toBe("angle:br/");
  });

  it("ignores attribute order and quote style", () => {
    expect(idOf(`<a href="/t" id="x">`)).toBe(idOf(`<a id="x" href="/t">`));
    expect(idOf(`<a href='/t'>`)).toBe(idOf(`<a href="/t">`));
  });

  it("ignores attributes on a closing tag, which cannot have any", () => {
    expect(idOf("</a>")).toBe("angle:/a");
  });
});

// ---------------------------------------------------------------------------
// The five proven corruptions
// ---------------------------------------------------------------------------

describe("attribute corruptions must not ship as passed", () => {
  it("accepts the correct control translation", () => {
    const target =
      'Lesen Sie unsere <a href="/terms">Bedingungen</a> und <a href="/privacy">Datenschutzrichtlinie</a>.';
    const result = ship(SOURCE, target);
    expect(result.issues).toEqual([]);
    expect(result.status).toBe("passed");
    expect(result.repair).toBe(false);
  });

  it("fails a translated URL (404 in production)", () => {
    const target =
      'Lesen Sie unsere <a href="/bedingungen">Bedingungen</a> und <a href="/datenschutz">Datenschutzrichtlinie</a>.';
    const result = ship(SOURCE, target);
    expect(result.status).toBe("failed");
    expect(result.repair).toBe(true);

    const attrs = attributeIssues(result.issues);
    expect(attrs).toHaveLength(2);
    expect(attrs[0]?.message).toBe(
      'The <a> tag\'s href attribute changed from "/terms" to "/bedingungen". Attribute values are not translatable content — reproduce the tag exactly as <a href="/terms">.',
    );
    expect(attrs[0]?.detail).toEqual({
      raw: '<a href="/terms">',
      token: "a",
      kind: "angle-tag",
      attribute: "href",
      expected: "/terms",
      actual: "/bedingungen",
      reason: "attribute-drift",
    });
    expect(attrs[0]?.key).toBe("legal.terms");
    // One mistake, one report — never the confusing missing + added pair.
    expect(codes(result.issues)).not.toContain("placeholder-missing");
    expect(codes(result.issues)).not.toContain("placeholder-added");
  });

  it("fails a dropped attribute", () => {
    const target =
      'Lesen Sie unsere <a>Bedingungen</a> und <a href="/privacy">Datenschutzrichtlinie</a>.';
    const result = ship(SOURCE, target);
    expect(result.status).toBe("failed");
    const attrs = attributeIssues(result.issues);
    expect(attrs).toHaveLength(1);
    expect(attrs[0]?.detail?.["reason"]).toBe("attribute-missing");
    expect(attrs[0]?.detail?.["expected"]).toBe("/terms");
    expect(attrs[0]?.detail?.["actual"]).toBeNull();
    expect(attrs[0]?.message).toContain("lost its href attribute");
  });

  it("fails an emptied href", () => {
    const target =
      'Lesen Sie unsere <a href="">Bedingungen</a> und <a href="/privacy">Datenschutzrichtlinie</a>.';
    const result = ship(SOURCE, target);
    expect(result.status).toBe("failed");
    const attrs = attributeIssues(result.issues);
    expect(attrs).toHaveLength(1);
    expect(attrs[0]?.detail?.["reason"]).toBe("attribute-drift");
    expect(attrs[0]?.detail?.["actual"]).toBe("");
  });

  it("fails hrefs swapped between two sibling links", () => {
    // The multiset of identities is IDENTICAL here — only the pairing by
    // position reveals the swap.
    const target =
      'Lesen Sie unsere <a href="/privacy">Bedingungen</a> und <a href="/terms">Datenschutzrichtlinie</a>.';
    const result = ship(SOURCE, target);
    expect(result.status).toBe("failed");
    const attrs = attributeIssues(result.issues);
    expect(attrs).toHaveLength(2);
    expect(attrs.map((i) => i.detail?.["actual"])).toEqual([
      "/privacy",
      "/terms",
    ]);
    // Swapped destinations are a corruption, not a word-order choice.
    expect(codes(result.issues)).not.toContain("placeholder-reordered");
  });

  it("fails injected target/rel attributes", () => {
    const target =
      'Lesen Sie unsere <a href="/terms" target="_blank" rel="noopener">Bedingungen</a> und <a href="/privacy">Datenschutzrichtlinie</a>.';
    const result = ship(SOURCE, target);
    expect(result.status).toBe("failed");
    const attrs = attributeIssues(result.issues);
    expect(attrs).toHaveLength(2);
    expect(attrs.map((i) => i.detail?.["attribute"])).toEqual(["rel", "target"]);
    expect(attrs.every((i) => i.detail?.["reason"] === "attribute-added")).toBe(
      true,
    );
    expect(attrs.every((i) => i.detail?.["expected"] === null)).toBe(true);
  });
});

describe("attribute parity on other tag shapes", () => {
  it("fails a self-closing image that lost src and alt", () => {
    const source = 'Logo <img src="/logo.png" alt="Acme"/> here';
    const result = ship(source, "Logo <img/> hier");
    expect(result.status).toBe("failed");
    const attrs = attributeIssues(result.issues);
    expect(attrs.map((i) => i.detail?.["attribute"])).toEqual(["alt", "src"]);
    expect(attrs.every((i) => i.detail?.["reason"] === "attribute-missing")).toBe(
      true,
    );
  });

  it("fails an injected event handler on a plain tag", () => {
    const result = ship(
      "Hello <b>world</b>",
      '<b onclick="steal()">Hallo</b> Welt',
      { ...CTX, key: "greeting" },
    );
    expect(result.status).toBe("failed");
    const attrs = attributeIssues(result.issues);
    expect(attrs).toHaveLength(1);
    expect(attrs[0]?.detail?.["attribute"]).toBe("onclick");
    expect(attrs[0]?.detail?.["reason"]).toBe("attribute-added");
  });

  it("still reports a genuinely absent tag as missing, not as attribute drift", () => {
    const result = ship(
      'Read our <a href="/terms">terms</a>.',
      "Lesen Sie unsere Bedingungen.",
      { ...CTX, key: "legal.only" },
    );
    expect(codes(result.issues)).toContain("placeholder-missing");
    expect(attributeIssues(result.issues)).toEqual([]);
  });

  it("reports the surplus tag as missing when the target drops one of two links", () => {
    const target = 'Lesen Sie unsere <a href="/terms">Bedingungen</a>.';
    const result = ship(SOURCE, target);
    expect(codes(result.issues)).toContain("placeholder-missing");
    expect(attributeIssues(result.issues)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Regressions: what must stay clean
// ---------------------------------------------------------------------------

describe("attribute parity does not fire on legitimate variation", () => {
  it("accepts reordered attributes", () => {
    const source = 'See <a href="/t" id="x">terms</a>';
    const target = 'Siehe <a id="x" href="/t">Bedingungen</a>';
    expect(validatePlaceholderParity(source, target, CTX)).toEqual([]);
    expect(ship(source, target).status).toBe("passed");
  });

  it("accepts a changed quote style", () => {
    const source = `See <a href="/t">terms</a>`;
    const target = `Siehe <a href='/t'>Bedingungen</a>`;
    expect(ship(source, target).status).toBe("passed");
  });

  it("accepts attribute-name case changes", () => {
    const source = 'See <a href="/t">terms</a>';
    const target = 'Siehe <a HREF="/t">Bedingungen</a>';
    expect(ship(source, target).status).toBe("passed");
  });

  it("accepts a boolean attribute respelled as an empty value", () => {
    const source = "Type here <input disabled> now";
    const target = 'Hier tippen <input disabled=""> jetzt';
    expect(validatePlaceholderParity(source, target, CTX)).toEqual([]);
  });

  it("leaves <Trans> index tags and plain markup alone", () => {
    const source = "Click <0>here</0> to <b>continue</b>";
    const target = "Klicken Sie <0>hier</0>, um <b>fortzufahren</b>";
    expect(validatePlaceholderParity(source, target, CTX)).toEqual([]);
    expect(ship(source, target).status).toBe("passed");
  });

  it("still allows grammatical reordering of attribute-free tags", () => {
    const source = "<b>Save</b> the <i>file</i>";
    const target = "Die <i>Datei</i> <b>speichern</b>";
    const issues = validatePlaceholderParity(source, target, CTX);
    expect(codes(issues)).toEqual(["placeholder-reordered"]);
    expect(issues[0]?.severity).toBe("info");
  });

  it("still allows grammatical reordering of two identically-attributed tags", () => {
    const source = '<a href="/a">Alpha</a> then <a href="/a">Beta</a>';
    const target = '<a href="/a">Beta</a> dann <a href="/a">Alpha</a>';
    expect(validatePlaceholderParity(source, target, CTX)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Repair feedback
// ---------------------------------------------------------------------------

function unitFor(source: string): TranslationUnit {
  return {
    key: "legal.terms",
    source,
    role: "body",
    placeholders: extractPlaceholders(source),
    ambiguities: [],
    budget: {
      maxRatio: 1.6,
      maxChars: null,
      graceRatio: 1.2,
      rationale: "body copy",
    },
    allowedWidth: 100,
    neighbors: [],
  };
}

describe("buildRepairFeedback for attribute problems", () => {
  it("names the attribute, the exact required value and the no-translate rule", () => {
    const target =
      'Lesen Sie unsere <a href="/bedingungen">Bedingungen</a> und <a href="/privacy">Datenschutzrichtlinie</a>.';
    const issues = validateString(SOURCE, target, CTX);
    const feedback = buildRepairFeedback(unitFor(SOURCE), target, issues, null);

    expect(feedback).toContain("href attribute");
    expect(feedback).toContain('"/terms"');
    expect(feedback).toContain('but you wrote "/bedingungen"');
    expect(feedback).toContain('Reproduce the tag verbatim as <a href="/terms">');
    expect(feedback.toLowerCase()).toContain("never translate");
    expect(feedback).toContain("URLs, IDs, CSS classes");
  });

  it("tells the model to restore a dropped attribute", () => {
    const target = 'Lesen Sie unsere <a>Bedingungen</a> und <a href="/privacy">X</a>.';
    const issues = validateString(SOURCE, target, CTX);
    const feedback = buildRepairFeedback(unitFor(SOURCE), target, issues, null);
    expect(feedback).toContain("dropped the href attribute");
    expect(feedback).toContain('href="/terms"');
  });

  it("tells the model to remove an injected attribute", () => {
    const target =
      'Lesen Sie unsere <a href="/terms" target="_blank">Bedingungen</a> und <a href="/privacy">X</a>.';
    const issues = validateString(SOURCE, target, CTX);
    const feedback = buildRepairFeedback(unitFor(SOURCE), target, issues, null);
    expect(feedback).toContain('You added target="_blank"');
    expect(feedback).toContain("which the source does not have");
  });

  it("mentions an emptied value explicitly rather than silently omitting it", () => {
    const target = 'Lesen Sie unsere <a href="">Bedingungen</a> und <a href="/privacy">X</a>.';
    const issues = validateString(SOURCE, target, CTX);
    const feedback = buildRepairFeedback(unitFor(SOURCE), target, issues, null);
    expect(feedback).toContain('but you wrote ""');
  });
});
