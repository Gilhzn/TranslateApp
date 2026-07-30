import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractPlaceholders,
  parseComplexIcuArgument,
  stripPlaceholders,
  topLevelPlaceholders,
} from "./placeholders";
import { classifyNonTranslatable } from "./translatable";
import { parseSourceFile } from "./parse";
import { flattenJson } from "./flatten";

/**
 * ICU plural/select regression suite.
 *
 * The bug this file exists to prevent: a plural block was consumed as ONE
 * opaque placeholder, its residue was empty, the classifier called it
 * "placeholder-only" and the flattener shipped it untranslated — so
 * "{count, plural, one {# seat} other {# seats}}" was emitted verbatim in
 * every target locale, and reported as a benign skip rather than a failure.
 * Plural and select are the most common message shapes in i18next / FormatJS
 * catalogues, so this is the difference between a working product and one that
 * silently leaks English.
 */

const classify = (value: string) =>
  classifyNonTranslatable(value, extractPlaceholders(value));
const tokens = (value: string): string[] =>
  extractPlaceholders(value).map((p) => p.token);

const SEATS = "{count, plural, one {# seat} other {# seats}}";
const GENDER = "{gender, select, male {He} female {She} other {They}}";
const NESTED = "{count, plural, one {# item for {name}} other {# items for {name}}}";

describe("ICU complex arguments are translatable copy", () => {
  it("does not classify a plural message as placeholder-only", () => {
    expect(classify(SEATS)).toBeNull();
    expect(
      classify("{n, plural, =0 {no builds} one {# build} other {# builds}}"),
    ).toBeNull();
    expect(
      classify("{n, selectordinal, one {#st} two {#nd} other {#th}}"),
    ).toBeNull();
  });

  it("does not classify a select message as placeholder-only", () => {
    expect(classify(GENDER)).toBeNull();
    expect(classify("{plan, select, pro {Pro} other {Free}}")).toBeNull();
  });

  it("keeps branch prose in the residue and drops only the skeleton", () => {
    const residue = stripPlaceholders(SEATS, extractPlaceholders(SEATS));
    expect(residue).toContain("seat");
    expect(residue).toContain("seats");
    // Skeleton — argument name, keyword, `#`, braces — must be gone, otherwise
    // "stray brace" validation would fire on every plural in the catalogue.
    expect(residue).not.toContain("count");
    expect(residue).not.toContain("plural");
    expect(residue).not.toContain("#");
    expect(residue).not.toMatch(/[{}]/);
  });

  it("still reports a plural whose branches carry no words", () => {
    // Nothing here is human copy; skipping it is correct.
    expect(classify("{count, plural, one {#} other {#}}")).toBe(
      "placeholder-only",
    );
    expect(
      classify("{count, plural, one {{count}} other {{count}}}"),
    ).toBe("placeholder-only");
  });

  it("exposes placeholders nested inside plural branches", () => {
    const found = extractPlaceholders(NESTED);
    expect(found.map((p) => p.token)).toContain("name");
    // The block itself is still ONE placeholder: the no-double-count contract.
    expect(found.filter((p) => p.token === "count")).toHaveLength(1);
    // One per branch, so a translator dropping it from either branch is caught.
    expect(found.filter((p) => p.token === "name")).toHaveLength(2);
    for (const p of found) {
      expect(NESTED.slice(p.index, p.index + p.raw.length)).toBe(p.raw);
    }
  });

  it("sees markup and printf inside branches", () => {
    expect(
      tokens("{n, plural, one {<b>#</b> file} other {<b>#</b> files}}"),
    ).toEqual(["n", "b", "b", "b", "b"]);
    expect(
      tokens("{s, select, a {Hi %s} other {Bye {{user}}}}"),
    ).toEqual(["s", "s", "user"]);
  });

  it("recurses through nested complex arguments", () => {
    const value =
      "{a, plural, one {{b, select, x {X for {who}} other {Y}}} other {many}}";
    const found = extractPlaceholders(value);
    expect(found.map((p) => p.token)).toEqual(["a", "b", "who"]);
    expect(stripPlaceholders(value, found)).toContain("X for");
    expect(classify(value)).toBeNull();
  });

  it("keeps placeholders ordered by index even with nesting", () => {
    const value = `Hi {user}, ${NESTED} — <b>ok</b>`;
    const indices = extractPlaceholders(value).map((p) => p.index);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  it("handles plural offsets and explicit selectors", () => {
    const value =
      "{n, plural, offset:1 =0 {nobody} one {you and # other} other {you and # others}}";
    expect(classify(value)).toBeNull();
    const residue = stripPlaceholders(value, extractPlaceholders(value));
    expect(residue).toContain("nobody");
    expect(residue).toContain("you and");
    expect(residue).not.toContain("offset");
  });

  it("handles the legacy choice format", () => {
    const value = "{n, choice, 0#no files|1#one file|1<{n} files}";
    const found = extractPlaceholders(value);
    expect(found.map((p) => p.token)).toEqual(["n", "n"]);
    const residue = stripPlaceholders(value, found);
    expect(residue).toContain("no files");
    expect(residue).toContain("one file");
    expect(residue).toContain("files");
    expect(residue).not.toContain("#");
    expect(residue).not.toContain("1<");
  });

  it("leaves simple arguments opaque", () => {
    expect(parseComplexIcuArgument("{name}")).toBeNull();
    expect(parseComplexIcuArgument("{amount, number, ::currency/EUR}")).toBeNull();
    expect(parseComplexIcuArgument("{when, date, short}")).toBeNull();
    expect(classify("{{first}} {{last}}")).toBe("placeholder-only");
    expect(extractPlaceholders("Hello {name}")).toHaveLength(1);
  });

  it("parses the argument head, format and branch spans", () => {
    const parsed = parseComplexIcuArgument(SEATS, 0);
    expect(parsed).not.toBeNull();
    expect(parsed?.arg).toBe("count");
    expect(parsed?.format).toBe("plural");
    expect(parsed?.subMessages.map((s) => s.text)).toEqual([
      "# seat",
      "# seats",
    ]);
    for (const sub of parsed?.subMessages ?? []) {
      expect(SEATS.slice(sub.index, sub.index + sub.text.length)).toBe(sub.text);
    }
  });

  it("offsets sub-message indices when the block is not at position 0", () => {
    const value = `You have ${SEATS} left`;
    const parsed = parseComplexIcuArgument(SEATS, value.indexOf(SEATS));
    for (const sub of parsed?.subMessages ?? []) {
      expect(value.slice(sub.index, sub.index + sub.text.length)).toBe(sub.text);
    }
  });

  it("topLevelPlaceholders drops the nested spans for span rewriters", () => {
    const top = topLevelPlaceholders(extractPlaceholders(NESTED));
    expect(top).toHaveLength(1);
    expect(top[0]?.raw).toBe(NESTED);

    // Spans returned are disjoint and in order, so a cursor walk is safe.
    let cursor = 0;
    for (const p of topLevelPlaceholders(
      extractPlaceholders(`{a} ${NESTED} {b}`),
    )) {
      expect(p.index).toBeGreaterThanOrEqual(cursor);
      cursor = p.index + p.raw.length;
    }
  });
});

describe("catalogue-level regression", () => {
  const fixturePath = fileURLToPath(
    new URL("../../fixtures/micro-saas-en.json", import.meta.url),
  );

  it("never skips an ICU plural/select message in the shipped fixture", () => {
    const catalog = parseSourceFile(
      "micro-saas-en.json",
      readFileSync(fixturePath, "utf8"),
    );
    const skippedIcu = catalog.entries.filter(
      (e) => e.doNotTranslate && /plural|select,/.test(e.value),
    );
    expect(skippedIcu.map((e) => e.key)).toEqual([]);
    expect(skippedIcu).toHaveLength(0);

    // The pricing copy specifically: it must reach the model.
    const seats = catalog.entries.find((e) => e.key === "billing.seats");
    expect(seats?.value).toBe(SEATS);
    expect(seats?.doNotTranslate).toBe(false);
  });

  it("keeps plural/select translatable in a synthetic i18next catalogue", () => {
    const entries = flattenJson({
      cart: {
        items: "{count, plural, one {# item} other {# items}}",
        greeting: "{gender, select, male {Welcome back, sir} other {Welcome}}",
        empty: "{{brand}}",
        link: "https://example.com/cart",
      },
    });
    const byKey = new Map(entries.map((e) => [e.key, e]));
    expect(byKey.get("cart.items")?.doNotTranslate).toBe(false);
    expect(byKey.get("cart.greeting")?.doNotTranslate).toBe(false);
    expect(byKey.get("cart.empty")?.doNotTranslate).toBe(true);
    expect(byKey.get("cart.link")?.doNotTranslate).toBe(true);
  });
});
