import { describe, expect, it } from "vitest";
import { extractPlaceholders, stripPlaceholders } from "./placeholders";

const kinds = (value: string): string[] =>
  extractPlaceholders(value).map((p) => p.kind);
const raws = (value: string): string[] =>
  extractPlaceholders(value).map((p) => p.raw);
const tokens = (value: string): string[] =>
  extractPlaceholders(value).map((p) => p.token);

describe("extractPlaceholders", () => {
  it("finds ICU arguments", () => {
    const found = extractPlaceholders("Hello {name}, you have {count} items");
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({
      raw: "{name}",
      kind: "icu",
      token: "name",
      index: 6,
    });
    expect(found[1]).toMatchObject({ raw: "{count}", token: "count" });
  });

  it("treats {{user}} as ONE double-brace placeholder, not two ICU ones", () => {
    const found = extractPlaceholders("Hi {{user}}!");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      raw: "{{user}}",
      kind: "double-brace",
      token: "user",
      index: 3,
    });
  });

  it("treats ${user} as ONE dollar-brace placeholder", () => {
    const found = extractPlaceholders("Hi ${user}");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "dollar-brace", token: "user" });
  });

  it("consumes a whole ICU plural block once, not its inner sub-messages", () => {
    const value = "{count, plural, one {# item} other {# items}}";
    const found = extractPlaceholders(value);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      raw: value,
      kind: "icu",
      token: "count",
      index: 0,
    });
  });

  it("recognises index arguments as unreal placeholders", () => {
    expect(kinds("{0} joined {1}")).toEqual(["unreal", "unreal"]);
    expect(tokens("{0} joined {1}")).toEqual(["0", "1"]);
    expect(kinds("{0, number}")).toEqual(["unreal"]);
  });

  it("handles printf conversions including positional ones", () => {
    expect(tokens("%s scored %d")).toEqual(["s", "d"]);
    expect(tokens("%1$s beat %2$s")).toEqual(["1", "2"]);
    expect(raws("%-5.2f")).toEqual(["%-5.2f"]);
  });

  it("does not treat %% as a placeholder", () => {
    expect(extractPlaceholders("100%% loaded")).toEqual([]);
    expect(tokens("%d%% done")).toEqual(["d"]);
  });

  it("does not misread a percent sign in prose", () => {
    expect(extractPlaceholders("50% off today")).toEqual([]);
    expect(extractPlaceholders("Battery at 100%")).toEqual([]);
  });

  it("handles Python named conversions", () => {
    const found = extractPlaceholders("Welcome %(name)s, level %(lvl)d");
    expect(found.map((p) => p.kind)).toEqual(["percent-named", "percent-named"]);
    expect(found.map((p) => p.token)).toEqual(["name", "lvl"]);
  });

  it("handles angle tags, including closing and numeric component tags", () => {
    const found = extractPlaceholders('Click <b>here</b> or <0>there</0>');
    expect(found.map((p) => p.raw)).toEqual(["<b>", "</b>", "<0>", "</0>"]);
    expect(found.map((p) => p.token)).toEqual(["b", "b", "0", "0"]);
    expect(new Set(found.map((p) => p.kind))).toEqual(new Set(["angle-tag"]));
  });

  it("handles attributes and self-closing tags", () => {
    expect(raws('Go <a href="/x">home</a><br/>')).toEqual([
      '<a href="/x">',
      "</a>",
      "<br/>",
    ]);
  });

  it("does not treat mathematical comparison as a tag", () => {
    expect(extractPlaceholders("a < b and c > d")).toEqual([]);
  });

  it("handles i18next nesting", () => {
    const found = extractPlaceholders("$t(common:cancel) or continue");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: "i18next-nesting",
      token: "common:cancel",
      raw: "$t(common:cancel)",
    });
  });

  it("normalises formatted arguments to the bare variable name", () => {
    expect(tokens("{{count, number}}")).toEqual(["count"]);
    expect(tokens("{amount, number, ::currency/EUR}")).toEqual(["amount"]);
  });

  it("returns placeholders ordered by index", () => {
    const found = extractPlaceholders("{{a}} %s {b} <i> ${c}");
    expect(found.map((p) => p.index)).toEqual(
      [...found.map((p) => p.index)].sort((x, y) => x - y),
    );
    expect(found.map((p) => p.kind)).toEqual([
      "double-brace",
      "printf",
      "icu",
      "angle-tag",
      "dollar-brace",
    ]);
  });

  it("ignores unbalanced or empty braces", () => {
    expect(extractPlaceholders("{unclosed")).toEqual([]);
    expect(extractPlaceholders("{}")).toEqual([]);
    expect(extractPlaceholders("{ }")).toEqual([]);
    // Not an argument: ICU argument bodies are a name, optionally followed by
    // a comma and format options.
    expect(extractPlaceholders("a {two words} c")).toEqual([]);
  });

  it("tolerates whitespace inside an ICU argument", () => {
    expect(tokens("a { b } c")).toEqual(["b"]);
  });

  it("never overlaps: raw spans are disjoint and in bounds", () => {
    const value = "{{a}} {b} %1$s <b>x</b> ${c} $t(k) %(n)s {0}";
    let cursor = 0;
    for (const p of extractPlaceholders(value)) {
      expect(p.index).toBeGreaterThanOrEqual(cursor);
      expect(value.slice(p.index, p.index + p.raw.length)).toBe(p.raw);
      cursor = p.index + p.raw.length;
    }
  });
});

describe("stripPlaceholders", () => {
  it("removes every placeholder span", () => {
    expect(stripPlaceholders("{{a}} and {b}", extractPlaceholders("{{a}} and {b}"))).toBe(
      " and ",
    );
  });

  it("is a no-op when there are no placeholders", () => {
    expect(stripPlaceholders("plain", [])).toBe("plain");
  });
});
