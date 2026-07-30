import { describe, expect, it } from "vitest";
import {
  JsonReadError,
  MAX_NESTING_DEPTH,
  readJsonDocument,
} from "./json-reader";
import { recordedKeyOrder } from "./key-order";

/**
 * The reader replaces `JSON.parse`, so the first duty of these tests is
 * *parity*: it must accept exactly the same language and produce exactly the
 * same values. The second duty is the thing `JSON.parse` cannot do — reporting
 * authored key order — and the third is error quality.
 */

const read = (text: string): unknown => readJsonDocument(text).root;

const readError = (text: string): JsonReadError => {
  try {
    readJsonDocument(text);
  } catch (error) {
    if (error instanceof JsonReadError) return error;
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(text)} to be rejected`);
};

describe("readJsonDocument value parity with JSON.parse", () => {
  const VALID = [
    "{}",
    "[]",
    '{"a":"b"}',
    '  {  "a" :  "b"  }  ',
    '{"a":1,"b":-2,"c":12.5,"d":6e3,"e":6E+3,"f":1e-3,"g":-0}',
    '{"t":true,"f":false,"n":null}',
    '{"nested":{"deep":{"deeper":["x",{"y":[]}]}}}',
    '["a",1,true,null,{},[]]',
    '"top level string"',
    "42",
    "true",
    "null",
    '{"esc":"quote\\" back\\\\ slash\\/ \\b\\f\\n\\r\\t"}',
    '{"unicode":"\\u00e9\\u0041\\ud83c\\udfae"}',
    '{"lone-surrogate":"\\ud800"}',
    '{"emoji":"🎮 direct"}',
    '{"empty-key":""}',
    '{"":"empty key name"}',
    '{"tab-in-source":"a\\tb"}',
    "\n\t{\r\n\t\t\"crlf\": \"yes\"\r\n\t}\n",
    '{"big":[[[[["deep"]]]]]}',
  ];

  it("produces values identical to JSON.parse", () => {
    for (const text of VALID) {
      expect(read(text)).toEqual(JSON.parse(text));
    }
  });

  it("preserves -0 and large/small magnitudes the way JSON.parse does", () => {
    const doc = read('{"negZero":-0,"huge":1e308,"tiny":5e-324}') as Record<
      string,
      number
    >;
    expect(Object.is(doc["negZero"], -0)).toBe(true);
    expect(doc["huge"]).toBe(1e308);
    expect(doc["tiny"]).toBe(5e-324);
  });

  it("takes the last value for a duplicated key, like JSON.parse", () => {
    const text = '{"a":1,"b":2,"a":3}';
    expect(read(text)).toEqual(JSON.parse(text));
    // ...and keeps the key at the position of its first appearance.
    expect(readJsonDocument(text).keyOrder.get("")).toEqual(["a", "b"]);
  });

  it("treats __proto__ as an ordinary own key without touching the prototype", () => {
    const doc = readJsonDocument('{"__proto__":{"polluted":true},"safe":1}');
    const root = doc.root as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(root, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(root)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(doc.keyOrder.get("")).toEqual(["__proto__", "safe"]);
  });
});

describe("readJsonDocument rejection parity", () => {
  const INVALID = [
    "",
    "   ",
    "{",
    "}",
    "[",
    '{"a"}',
    '{"a":}',
    '{"a":1,}',
    "[1,]",
    "[1 2]",
    '{"a":1 "b":2}',
    "{'a':1}",
    '{a:1}',
    '{"a":undefined}',
    '{"a":NaN}',
    '{"a":Infinity}',
    '{"a":True}',
    '{"a":01}',
    '{"a":+1}',
    '{"a":.5}',
    '{"a":5.}',
    '{"a":1.2.3}',
    '{"a":0x10}',
    '{"a":"unterminated}',
    '{"a":"bad \\q escape"}',
    '{"a":"short \\u12"}',
    '{"a":"raw\ncontrol"}',
    '{"a":1}{"b":2}',
    '{"a":1} trailing',
    '"a" "b"',
    "[1,2",
    '{"a":[1,2}',
  ];

  it("rejects everything JSON.parse rejects", () => {
    for (const text of INVALID) {
      expect(() => JSON.parse(text)).toThrow();
      expect(() => readJsonDocument(text)).toThrow(JsonReadError);
    }
  });

  it("reports an in-range offset for every rejection", () => {
    for (const text of INVALID) {
      const error = readError(text);
      expect(error.offset).toBeGreaterThanOrEqual(0);
      expect(error.offset).toBeLessThanOrEqual(text.length);
      expect(error.reason.length).toBeGreaterThan(0);
      // The location belongs on the error object, not smuggled into the prose.
      expect(error.reason).not.toMatch(/position \d+/i);
    }
  });

  it("points at the exact offending character", () => {
    expect(readError('{"a": }').offset).toBe(6);
    expect(readError('{"a" 1}').offset).toBe(5);
    expect(readError('{"a":1,}').offset).toBe(7);
    expect(readError('["x",]').offset).toBe(5);
    expect(readError('{"a":1} tail').offset).toBe(8);
    expect(readError('{"a":"raw\tcontrol"}').offset).toBe(9);
    expect(readError('{"a":01}').offset).toBe(5);
  });

  it("explains the common mistakes in the developer's own terms", () => {
    expect(readError('{"a":1,}').reason).toMatch(/trailing comma/i);
    expect(readError("[1,]").reason).toMatch(/trailing comma/i);
    expect(readError("{'a':1}").reason).toMatch(/double quotes/i);
    expect(readError('{"a":undefined}').reason).toMatch(/bareword 'undefined'/);
    expect(readError('{"a":NaN}').reason).toMatch(/bareword 'NaN'/);
    expect(readError('{"a":"x').reason).toMatch(/unterminated string/i);
    expect(readError('{"a":"\\q"}').reason).toMatch(/escape sequence/i);
    expect(readError('{"a":"\\u12"}').reason).toMatch(/hexadecimal/i);
    expect(readError('{"a":"raw\ncontrol"}').reason).toMatch(
      /control character U\+000A/,
    );
    expect(readError('{"a":01}').reason).toMatch(/leading zeros/i);
    expect(readError('{"a":1}{"b":2}').reason).toMatch(/top-level value/i);
    expect(readError('{"a" 1}').reason).toContain('"a"');
  });
});

describe("readJsonDocument key order", () => {
  it("records integer-like keys in source order, not numeric order", () => {
    const doc = readJsonDocument(
      '{"items":{"101":"Iron Sword","12":"Wooden Shield","7":"Health Potion"}}',
    );
    expect(doc.keyOrder.get("items")).toEqual(["101", "12", "7"]);
    // Proof that the plain object cannot carry this itself.
    const items = (doc.root as Record<string, Record<string, string>>)["items"];
    expect(Object.keys(items ?? {})).toEqual(["7", "12", "101"]);
  });

  it("records order for the root under the empty path", () => {
    const doc = readJsonDocument('{"9":"a","zeta":"b","1":"c"}');
    expect(doc.keyOrder.get("")).toEqual(["9", "zeta", "1"]);
  });

  it("keys nested nodes by their encoded path, arrays included", () => {
    const doc = readJsonDocument(
      '{"a":[{"9":"x","1":"y"}],"a.b":{"2":"p","1":"q"}}',
    );
    expect(doc.keyOrder.get("a[0]")).toEqual(["9", "1"]);
    expect(doc.keyOrder.get("a\\.b")).toEqual(["2", "1"]);
  });

  it("registers the order against the node identity as well", () => {
    const doc = readJsonDocument('{"m":{"10":"ten","2":"two","alpha":"a"}}');
    const m = (doc.root as Record<string, object>)["m"];
    expect(m).toBeDefined();
    expect(recordedKeyOrder(m as object)).toEqual(["10", "2", "alpha"]);
  });

  it("records nothing for empty objects", () => {
    const doc = readJsonDocument('{"empty":{}}');
    expect(doc.keyOrder.get("empty")).toBeUndefined();
  });
});

describe("readJsonDocument nesting limits", () => {
  const nest = (depth: number): string =>
    `${"[".repeat(depth)}1${"]".repeat(depth)}`;

  it("accepts realistically deep documents", () => {
    expect(() => readJsonDocument(nest(1000))).not.toThrow();
  });

  it("rejects documents deeper than the recursive walkers can survive", () => {
    const error = readError(nest(MAX_NESTING_DEPTH + 50));
    expect(error.reason).toMatch(/nesting is deeper than/i);
  });
});

// ---------------------------------------------------------------------------
// Mutation fuzzing against JSON.parse
// ---------------------------------------------------------------------------

/** Deterministic PRNG so a failure is always reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const SEED_DOCUMENT = JSON.stringify(
  {
    menu: { play: "Play", "2": "two", "10": "ten" },
    hud: ["a", 1, true, null, { x: -2.5e3, y: "\u00e9" }],
    empty: {},
    list: [],
    deep: { a: { b: { c: ["d"] } } },
  },
  null,
  2,
);

const MUTATION_CHARS = [
  "{",
  "}",
  "[",
  "]",
  '"',
  ":",
  ",",
  "\\",
  "0",
  "e",
  " ",
  "\n",
  "'",
  "x",
];

describe("mutation fuzzing", () => {
  it("agrees with JSON.parse on 3000 mutated documents", () => {
    const rand = makeRandom(0x5eed);
    for (let iteration = 0; iteration < 3000; iteration++) {
      const at = Math.floor(rand() * SEED_DOCUMENT.length);
      const roll = rand();
      const inserted =
        MUTATION_CHARS[Math.floor(rand() * MUTATION_CHARS.length)] ?? "x";
      const mutated =
        roll < 0.34
          ? SEED_DOCUMENT.slice(0, at) + SEED_DOCUMENT.slice(at + 1) // delete
          : roll < 0.67
            ? SEED_DOCUMENT.slice(0, at) + inserted + SEED_DOCUMENT.slice(at) // insert
            : SEED_DOCUMENT.slice(0, at) +
              inserted +
              SEED_DOCUMENT.slice(at + 1); // replace

      let expected: unknown;
      let engineThrew = false;
      try {
        expected = JSON.parse(mutated);
      } catch {
        engineThrew = true;
      }

      let actual: unknown;
      let readerThrew = false;
      try {
        actual = readJsonDocument(mutated).root;
      } catch (error) {
        readerThrew = true;
        expect(error).toBeInstanceOf(JsonReadError);
        expect((error as JsonReadError).offset).toBeLessThanOrEqual(
          mutated.length,
        );
      }

      // Same verdict, and where both accept, the same value.
      expect({ mutated, threw: readerThrew }).toEqual({
        mutated,
        threw: engineThrew,
      });
      if (!engineThrew) expect(actual).toEqual(expected);
    }
  });
});
