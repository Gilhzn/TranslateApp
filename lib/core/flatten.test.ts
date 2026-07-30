import { describe, expect, it } from "vitest";
import type { JsonValue } from "@/lib/types";
import { collectTreeStats, flattenJson, rebuildTree } from "./flatten";
import { decodeKey } from "./keys";

const keysOf = (tree: JsonValue): string[] =>
  flattenJson(tree).map((e) => e.key);

describe("flattenJson", () => {
  it("preserves document order", () => {
    const tree: JsonValue = {
      zeta: "one",
      alpha: "two",
      middle: { second: "three", first: "four" },
    };
    expect(keysOf(tree)).toEqual([
      "zeta",
      "alpha",
      "middle.second",
      "middle.first",
    ]);
  });

  it("walks arrays with numeric path segments", () => {
    const tree: JsonValue = {
      errors: [{ title: "A" }, { title: "B" }],
      tags: ["x", "y"],
    };
    expect(keysOf(tree)).toEqual([
      "errors[0].title",
      "errors[1].title",
      "tags[0]",
      "tags[1]",
    ]);
    const entry = flattenJson(tree)[0];
    expect(entry?.path).toEqual(["errors", 0, "title"]);
  });

  it("emits entries only for string leaves", () => {
    const tree: JsonValue = {
      text: "hello",
      count: 3,
      enabled: true,
      missing: null,
      empty: {},
      list: [],
      nested: { deep: 1.5 },
    };
    expect(keysOf(tree)).toEqual(["text"]);
  });

  it("escapes keys that contain dots or brackets, and decodes them back", () => {
    const tree: JsonValue = { "app.name": "LingoLoop", "items[]": { x: "y" } };
    const entries = flattenJson(tree);
    expect(entries.map((e) => e.key)).toEqual(["app\\.name", "items\\[\\].x"]);
    for (const entry of entries) {
      expect(decodeKey(entry.key)).toEqual(entry.path);
    }
  });

  it("populates analysis fields on every entry", () => {
    const entries = flattenJson({
      buttons: { save: "Save" },
      url: "https://example.com",
      greeting: "Hi {{name}}",
    });
    const save = entries.find((e) => e.key === "buttons.save");
    expect(save?.role).toBe("button");
    expect(save?.doNotTranslate).toBe(false);
    expect(save?.ambiguities.length).toBeGreaterThan(0);

    const url = entries.find((e) => e.key === "url");
    expect(url?.doNotTranslate).toBe(true);
    expect(url?.ambiguities).toEqual([]);

    const greeting = entries.find((e) => e.key === "greeting");
    expect(greeting?.placeholders.map((p) => p.token)).toEqual(["name"]);
  });
});

describe("developer notes", () => {
  it("attaches sibling _comment/_context notes and does not emit them", () => {
    const entries = flattenJson({
      checkout: {
        _context: "Shown in the payment sheet",
        pay: "Pay now",
        cancel: "Cancel",
      },
    });
    expect(entries.map((e) => e.key)).toEqual([
      "checkout.pay",
      "checkout.cancel",
    ]);
    expect(entries[0]?.developerNote).toBe("Shown in the payment sheet");
    expect(entries[1]?.developerNote).toBe("Shown in the payment sheet");
  });

  it("supports every documented level-note key", () => {
    for (const noteKey of ["_comment", "_context", "_description", "_note"]) {
      const entries = flattenJson({ [noteKey]: "note text", a: "A" });
      expect(entries.map((e) => e.key)).toEqual(["a"]);
      expect(entries[0]?.developerNote).toBe("note text");
    }
  });

  it("supports @key and key_comment companions", () => {
    const entries = flattenJson({
      title: "Dashboard",
      "@title": "The main nav heading",
      subtitle: "Overview",
      subtitle_comment: "Sits under the title",
    });
    expect(entries.map((e) => e.key)).toEqual(["title", "subtitle"]);
    expect(entries[0]?.developerNote).toBe("The main nav heading");
    expect(entries[1]?.developerNote).toBe("Sits under the title");
  });

  it("prefers a companion note over the inherited level note", () => {
    const entries = flattenJson({
      _context: "Section-wide",
      a: "A",
      "@a": "Specific to A",
      b: "B",
    });
    expect(entries.find((e) => e.key === "a")?.developerNote).toBe(
      "Specific to A",
    );
    expect(entries.find((e) => e.key === "b")?.developerNote).toBe(
      "Section-wide",
    );
  });

  it("propagates a section note downward until a nearer one overrides it", () => {
    const entries = flattenJson({
      _context: "Outer",
      deep: { inner: "X", deeper: { _note: "Inner", y: "Y" } },
    });
    expect(entries.find((e) => e.key === "deep.inner")?.developerNote).toBe(
      "Outer",
    );
    expect(
      entries.find((e) => e.key === "deep.deeper.y")?.developerNote,
    ).toBe("Inner");
  });

  it("keeps an orphan companion translatable", () => {
    const entries = flattenJson({ "@ghost": "not a note, no sibling" });
    expect(entries.map((e) => e.key)).toEqual(["@ghost"]);
  });

  it("keeps a non-string _comment as real content", () => {
    const entries = flattenJson({ _comment: { nested: "value" } });
    expect(entries.map((e) => e.key)).toEqual(["_comment.nested"]);
  });
});

describe("rebuildTree", () => {
  const complex: JsonValue = {
    version: 3,
    enabled: true,
    nothing: null,
    ratio: 1.5,
    empty: {},
    emptyList: [],
    menu: {
      file: { save: "Save", open: "Open" },
      recent: ["one.json", "two.json"],
    },
    levels: [
      {
        name: "Forest",
        waves: [
          { enemies: ["Slime", "Bat"], boss: "Ancient Tree", hp: 500 },
          { enemies: [], boss: null, hp: 0 },
        ],
      },
      { name: "Cave", waves: [] },
    ],
  };

  it("is the identity when there is nothing to substitute", () => {
    expect(rebuildTree(complex, new Map())).toEqual(complex);
    expect(JSON.stringify(rebuildTree(complex, new Map()))).toBe(
      JSON.stringify(complex),
    );
  });

  it("substitutes only the keys present in the map", () => {
    const out = rebuildTree(
      complex,
      new Map([["menu.file.save", "Speichern"]]),
    ) as Record<string, JsonValue>;
    const menu = out["menu"] as Record<string, JsonValue>;
    const file = menu["file"] as Record<string, string>;
    expect(file["save"]).toBe("Speichern");
    expect(file["open"]).toBe("Open");
  });

  it("survives deeply nested arrays of objects of arrays", () => {
    const translations = new Map<string, string>();
    for (const entry of flattenJson(complex)) {
      translations.set(entry.key, `«${entry.value}»`);
    }
    const out = rebuildTree(complex, translations);

    // Structure identical, only string leaves changed.
    const shape = (node: JsonValue): JsonValue => {
      if (typeof node === "string") return "<string>";
      if (Array.isArray(node)) return node.map(shape);
      if (node !== null && typeof node === "object") {
        const o: { [k: string]: JsonValue } = {};
        for (const k of Object.keys(node)) {
          const child = node[k];
          if (child !== undefined) o[k] = shape(child);
        }
        return o;
      }
      return node;
    };
    expect(shape(out)).toEqual(shape(complex));
    expect(JSON.stringify(Object.keys(out as object))).toBe(
      JSON.stringify(Object.keys(complex as object)),
    );

    const levels = (out as Record<string, JsonValue>)["levels"] as JsonValue[];
    const first = levels[0] as Record<string, JsonValue>;
    const waves = first["waves"] as JsonValue[];
    const wave0 = waves[0] as Record<string, JsonValue>;
    expect(wave0["enemies"]).toEqual(["«Slime»", "«Bat»"]);
    expect(wave0["boss"]).toBe("«Ancient Tree»");
    expect(wave0["hp"]).toBe(500);
    const wave1 = waves[1] as Record<string, JsonValue>;
    expect(wave1["enemies"]).toEqual([]);
    expect(wave1["boss"]).toBeNull();
  });

  it("keeps array lengths exactly", () => {
    const tree: JsonValue = { a: ["x", 1, null, true, ["y"]] };
    const out = rebuildTree(tree, new Map([["a[0]", "z"]])) as Record<
      string,
      JsonValue
    >;
    expect(out["a"]).toEqual(["z", 1, null, true, ["y"]]);
  });

  it("restores strings under escaped keys", () => {
    const tree: JsonValue = { "a.b": "x", "c[0]": "y" };
    const entries = flattenJson(tree);
    const translations = new Map(entries.map((e) => [e.key, `T:${e.value}`]));
    expect(rebuildTree(tree, translations)).toEqual({
      "a.b": "T:x",
      "c[0]": "T:y",
    });
  });

  it("leaves developer-note keys untouched", () => {
    const tree: JsonValue = { _comment: "internal", a: "A" };
    const out = rebuildTree(tree, new Map([["a", "Ä"]]));
    expect(out).toEqual({ _comment: "internal", a: "Ä" });
  });

  it("ignores translations for keys that do not exist", () => {
    const tree: JsonValue = { a: "A" };
    expect(rebuildTree(tree, new Map([["nope.gone", "X"]]))).toEqual(tree);
  });
});

describe("collectTreeStats", () => {
  it("counts every primitive leaf and the deepest path", () => {
    expect(collectTreeStats({ a: "x" })).toEqual({
      totalLeaves: 1,
      maxDepth: 1,
    });
    expect(collectTreeStats({ a: { b: { c: "x" } }, n: 1, t: null })).toEqual({
      totalLeaves: 3,
      maxDepth: 3,
    });
    expect(collectTreeStats({ a: [{ b: ["x"] }] })).toEqual({
      totalLeaves: 1,
      maxDepth: 4,
    });
    expect(collectTreeStats({ empty: {} })).toEqual({
      totalLeaves: 0,
      maxDepth: 1,
    });
  });
});
