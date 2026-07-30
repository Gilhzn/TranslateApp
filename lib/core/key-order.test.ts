import { describe, expect, it } from "vitest";
import type { JsonValue } from "@/lib/types";
import {
  orderKeys,
  recordedKeyOrder,
  registerKeyOrder,
  resolveKeyOrder,
  setMember,
  toSerializableKeyOrder,
  keyOrderFromEntries,
  type KeyOrderMap,
  type SerializedKeyOrder,
} from "./key-order";
import { readJsonDocument } from "./json-reader";
import { flattenJson, rebuildTree } from "./flatten";
import { parseSourceFile, serializeWithCatalogFormatting } from "./parse";

/**
 * Regression suite for the defect that made this module fail review: a locale
 * file whose keys look like integers ("101", "12", "7", or a plural map mixing
 * "0" with "one"/"other") came back *reordered*, because a plain JS object
 * hoists integer-index keys ahead of string keys in ascending numeric order.
 *
 * Note that these cases cannot be written as object literals — `{"10":1,"2":2}`
 * is already reordered by the time the literal is evaluated. Every test here
 * therefore starts from *text*, which is exactly how the product receives them.
 */

describe("orderKeys", () => {
  const node = { b: 1, a: 2, c: 3 } as unknown as { [k: string]: JsonValue };

  it("falls back to Object.keys when nothing was recorded", () => {
    expect(orderKeys(node, undefined)).toEqual(["b", "a", "c"]);
    expect(orderKeys(node, [])).toEqual(["b", "a", "c"]);
  });

  it("applies a recorded order", () => {
    expect(orderKeys(node, ["c", "a", "b"])).toEqual(["c", "a", "b"]);
  });

  it("never drops a key that the recorded order forgot", () => {
    expect(orderKeys(node, ["c"])).toEqual(["c", "b", "a"]);
  });

  it("ignores recorded keys that are no longer present", () => {
    expect(orderKeys(node, ["gone", "c", "a", "vanished", "b"])).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("collapses duplicates in the recorded order", () => {
    expect(orderKeys(node, ["a", "a", "b", "c", "b"])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("always returns a permutation of the node's own keys", () => {
    const out = orderKeys(node, ["c", "zzz", "c"]);
    expect([...out].sort()).toEqual(Object.keys(node).sort());
  });
});

describe("resolveKeyOrder", () => {
  it("prefers an explicit map over the identity registry", () => {
    const node: { [k: string]: JsonValue } = { a: 1, b: 2 };
    registerKeyOrder(node, ["b", "a"]);
    const map: KeyOrderMap = new Map([["some.path", ["a", "b"]]]);
    expect(resolveKeyOrder(node, ["some", "path"], map)).toEqual(["a", "b"]);
    // A map that says nothing about this node falls through to the registry.
    expect(resolveKeyOrder(node, ["elsewhere"], map)).toEqual(["b", "a"]);
    expect(resolveKeyOrder(node, ["some", "path"], undefined)).toEqual([
      "b",
      "a",
    ]);
  });

  it("returns undefined for a node nobody recorded", () => {
    expect(resolveKeyOrder({ a: 1 }, ["a"], undefined)).toBeUndefined();
  });
});

describe("key order across a JSON boundary", () => {
  it("survives a stringify/parse hop and still orders the emitted file", () => {
    const source =
      '{\n  "items": {\n    "101": "Iron Sword",\n    "12": "Wooden Shield",\n    "7": "Health Potion"\n  }\n}\n';
    const catalog = parseSourceFile("en.json", source);

    // Exactly what an API route would put on the wire.
    const wire = JSON.stringify({
      tree: catalog.tree,
      keyOrder: toSerializableKeyOrder(catalog.keyOrder),
      indent: catalog.indent,
      trailingNewline: catalog.trailingNewline,
    });
    const received = JSON.parse(wire) as {
      tree: JsonValue;
      keyOrder: SerializedKeyOrder;
      indent: string;
      trailingNewline: boolean;
    };
    const keyOrder = keyOrderFromEntries(received.keyOrder);

    // The rehydrated tree is a fresh object the identity registry never saw.
    expect(recordedKeyOrder(received.tree as object)).toBeUndefined();
    expect(
      serializeWithCatalogFormatting(
        {
          indent: received.indent,
          trailingNewline: received.trailingNewline,
          keyOrder,
        },
        rebuildTree(received.tree, new Map(), keyOrder),
      ),
    ).toBe(source);
  });
});

describe("setMember", () => {
  it("stores __proto__ as an own data property", () => {
    const target: { [k: string]: JsonValue } = {};
    setMember(target, "__proto__", { polluted: true });
    expect(Object.prototype.hasOwnProperty.call(target, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("integer-like keys survive the full pipeline", () => {
  const exactRoundTrip = (source: string): void => {
    const catalog = parseSourceFile("en.json", source);
    const rebuilt = rebuildTree(catalog.tree, new Map(), catalog.keyOrder);
    expect(serializeWithCatalogFormatting(catalog, rebuilt)).toBe(source);
  };

  it("re-emits a numeric item catalogue byte-for-byte (REPRO 1)", () => {
    exactRoundTrip(
      '{\n  "items": {\n    "101": "Iron Sword",\n    "12": "Wooden Shield",\n    "7": "Health Potion"\n  }\n}\n',
    );
  });

  it("re-emits a plural map mixing integer and word keys (REPRO 2)", () => {
    exactRoundTrip(
      '{"cart":{"other":"{count} items","one":"1 item","0":"Cart is empty"}}',
    );
  });

  it("re-emits an HTTP error map in source order", () => {
    exactRoundTrip(
      '{\n  "errors": {\n    "500": "Server error",\n    "404": "Not found",\n    "403": "Forbidden",\n    "generic": "Something broke"\n  }\n}\n',
    );
  });

  it("keeps order inside arrays and deeply nested nodes", () => {
    exactRoundTrip(
      '{\n\t"levels": [\n\t\t{\n\t\t\t"3": "Third",\n\t\t\t"1": "First",\n\t\t\t"waves": {\n\t\t\t\t"10": "Ten",\n\t\t\t\t"2": "Two"\n\t\t\t}\n\t\t}\n\t]\n}',
    );
  });

  it("flattens in document order, not numeric order (REPRO 3)", () => {
    const catalog = parseSourceFile(
      "en.json",
      '{"m":{"10":"ten","2":"two","alpha":"a"}}',
    );
    expect(catalog.entries.map((e) => e.key)).toEqual([
      "m.10",
      "m.2",
      "m.alpha",
    ]);
  });

  it("flattens in document order when handed an explicit key order map", () => {
    const { root, keyOrder } = readJsonDocument(
      '{"m":{"10":"ten","2":"two","alpha":"a"}}',
    );
    expect(flattenJson(root, keyOrder).map((e) => e.key)).toEqual([
      "m.10",
      "m.2",
      "m.alpha",
    ]);
    // Same result without threading the map, via the identity registry.
    expect(flattenJson(root).map((e) => e.key)).toEqual([
      "m.10",
      "m.2",
      "m.alpha",
    ]);
  });

  it("carries the order onto rebuilt nodes, so serialising needs no map", () => {
    const source =
      '{\n  "items": {\n    "101": "Iron Sword",\n    "12": "Wooden Shield"\n  }\n}\n';
    const catalog = parseSourceFile("en.json", source);
    const rebuilt = rebuildTree(catalog.tree, new Map());
    expect(
      serializeWithCatalogFormatting(
        { indent: catalog.indent, trailingNewline: catalog.trailingNewline },
        rebuilt,
      ),
    ).toBe(source);
  });

  it("substitutes translations without disturbing the order", () => {
    const source =
      '{\n  "items": {\n    "101": "Iron Sword",\n    "12": "Wooden Shield",\n    "7": "Health Potion"\n  }\n}\n';
    const catalog = parseSourceFile("en.json", source);
    const translations = new Map(
      catalog.entries.map((e) => [e.key, e.value.toUpperCase()]),
    );
    const output = serializeWithCatalogFormatting(
      catalog,
      rebuildTree(catalog.tree, translations, catalog.keyOrder),
    );
    expect(output).toBe(
      '{\n  "items": {\n    "101": "IRON SWORD",\n    "12": "WOODEN SHIELD",\n    "7": "HEALTH POTION"\n  }\n}\n',
    );
  });

  it("reports the order on the catalog itself", () => {
    const catalog = parseSourceFile(
      "en.json",
      '{"a":{"9":"x","1":"y"},"z":"w"}',
    );
    expect(catalog.keyOrder.get("")).toEqual(["a", "z"]);
    expect(catalog.keyOrder.get("a")).toEqual(["9", "1"]);
  });

  it("still emits every key when the supplied order is stale", () => {
    const catalog = parseSourceFile("en.json", '{"2":"two","1":"one"}');
    // A map from some other document: unknown keys, and one real key missing.
    const stale: KeyOrderMap = new Map([["", ["ghost", "1"]]]);
    const output = serializeWithCatalogFormatting(
      { indent: "", trailingNewline: false, keyOrder: stale },
      catalog.tree,
    );
    expect(output).toBe('{"1":"one","2":"two"}');
  });
});

describe("emitter byte-compatibility with JSON.stringify", () => {
  /** Deterministic PRNG so a failure is always reproducible. */
  const makeRandom = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  };

  // Non-integer keys only: for those, JS property order *is* source order, so
  // JSON.stringify is a valid oracle for everything else about the formatting.
  const KEYS = ["a", "zz", "with space", "with.dot", "esc\"quote", "ünï", ""];

  const randomTree = (rand: () => number, depth: number): JsonValue => {
    const roll = rand();
    if (depth <= 0 || roll < 0.4) {
      const leaf = rand();
      if (leaf < 0.5) return `s${Math.floor(rand() * 100)}\n\t"\\`;
      if (leaf < 0.65) return Math.floor(rand() * 1000) - 500;
      if (leaf < 0.75) return rand() * 1e6;
      if (leaf < 0.85) return rand() < 0.5;
      return null;
    }
    if (roll < 0.7) {
      const out: JsonValue[] = [];
      const length = Math.floor(rand() * 4);
      for (let i = 0; i < length; i++) out.push(randomTree(rand, depth - 1));
      return out;
    }
    const out: { [k: string]: JsonValue } = {};
    const count = Math.floor(rand() * 5);
    for (let i = 0; i < count; i++) {
      out[`${KEYS[Math.floor(rand() * KEYS.length)] ?? "k"}${i}`] = randomTree(
        rand,
        depth - 1,
      );
    }
    return out;
  };

  it("matches JSON.stringify for every indent style on 300 random trees", () => {
    for (const indent of ["", "  ", "    ", "\t"]) {
      for (let seed = 1; seed <= 300; seed++) {
        const tree = randomTree(makeRandom(seed), 5);
        expect(
          serializeWithCatalogFormatting(
            { indent, trailingNewline: false },
            tree,
          ),
        ).toBe(JSON.stringify(tree, null, indent));
      }
    }
  });

  it("emits empty containers compactly, exactly like JSON.stringify", () => {
    const tree: JsonValue = { a: {}, b: [], c: { d: [] } };
    for (const indent of ["", "  ", "\t"]) {
      expect(
        serializeWithCatalogFormatting({ indent, trailingNewline: false }, tree),
      ).toBe(JSON.stringify(tree, null, indent));
    }
  });

  it("honours an indent wider than JSON.stringify's ten-character cap", () => {
    const wide = " ".repeat(12);
    const source = `{\n${wide}"a": "b"\n}\n`;
    const catalog = parseSourceFile("en.json", source);
    expect(catalog.indent).toBe(wide);
    expect(
      serializeWithCatalogFormatting(catalog, rebuildTree(catalog.tree, new Map())),
    ).toBe(source);
  });
});
