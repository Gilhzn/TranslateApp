import { describe, expect, it } from "vitest";
import type { JsonValue } from "@/lib/types";
import { flattenJson, rebuildTree } from "./flatten";
import { parseSourceFile, serializeWithCatalogFormatting } from "./parse";
import { decodeKey, encodeKey } from "./keys";

/**
 * Quality bar #2: the emitted file is structurally identical to the input.
 * These tests treat that as a byte-level property, not a vibe.
 */

const GAME_FILE = `{
  "_comment": "Strings for the roguelike prototype",
  "menu": {
    "play": "Play",
    "continue": "Continue Run",
    "options": "Options",
    "quit": "Quit to Desktop"
  },
  "hud": {
    "hp": "HP {current}/{max}",
    "combo": "{{count}}x Combo!",
    "timer": "%d min",
    "seed": "Seed: {0}",
    "empty": ""
  },
  "shop": {
    "@title": "Header of the in-run shop",
    "title": "Blacksmith",
    "buy": "Buy",
    "prices": [
      10,
      25,
      100
    ],
    "sold_out": true,
    "items": [
      {
        "name": "Rusty Sword",
        "rarity": "Common",
        "description": "A blade that has seen better days. Deals 3 damage and sometimes rusts your fingers too.",
        "stats": {
          "damage": 3,
          "crit": 0.05
        }
      },
      {
        "name": "Steam Vent",
        "rarity": "Legendary",
        "description": "Vents scalding steam in a cone. Buff your DPS for 5 s after each kill.",
        "stats": {
          "damage": 12,
          "crit": null
        }
      }
    ]
  },
  "links": {
    "discord": "https://discord.gg/example",
    "support": "support@example.com",
    "icon": "assets/ui/discord.svg"
  },
  "errors": [
    {
      "code": 404,
      "title": "Save not found",
      "body": "We could not find that save file. Start a new run?"
    }
  ]
}
`;

describe("byte-faithful round trip", () => {
  it("re-emits an untouched file exactly", () => {
    const catalog = parseSourceFile("en.json", GAME_FILE);
    const rebuilt = rebuildTree(catalog.tree, new Map());
    expect(serializeWithCatalogFormatting(catalog, rebuilt)).toBe(GAME_FILE);
  });

  it("changes nothing but the translated string leaves", () => {
    const catalog = parseSourceFile("en.json", GAME_FILE);
    const translations = new Map<string, string>();
    for (const entry of catalog.entries) {
      if (entry.doNotTranslate) continue;
      translations.set(entry.key, entry.value.toUpperCase());
    }
    const rebuilt = rebuildTree(catalog.tree, translations);
    const output = serializeWithCatalogFormatting(catalog, rebuilt);

    // Same line count, same indentation, same key order.
    const before = GAME_FILE.split("\n");
    const after = output.split("\n");
    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      const b = before[i] ?? "";
      const a = after[i] ?? "";
      expect(a.replace(/^\s*/, "")[0] ?? "").toBe(b.replace(/^\s*/, "")[0] ?? "");
      expect(/^\s*/.exec(a)?.[0]).toBe(/^\s*/.exec(b)?.[0]);
    }

    // Non-string leaves untouched.
    const tree = rebuilt as Record<string, JsonValue>;
    const shop = tree["shop"] as Record<string, JsonValue>;
    expect(shop["prices"]).toEqual([10, 25, 100]);
    expect(shop["sold_out"]).toBe(true);
    const items = shop["items"] as Array<Record<string, JsonValue>>;
    expect(items).toHaveLength(2);
    const stats1 = items[1]?.["stats"] as Record<string, JsonValue>;
    expect(stats1["crit"]).toBeNull();
    // Metadata keys keep their source text.
    expect(tree["_comment"]).toBe("Strings for the roguelike prototype");
    expect(shop["@title"]).toBe("Header of the in-run shop");
  });

  it("keeps do-not-translate values verbatim", () => {
    const catalog = parseSourceFile("en.json", GAME_FILE);
    const links = catalog.entries.filter((e) => e.key.startsWith("links."));
    expect(links).toHaveLength(3);
    for (const entry of links) expect(entry.doNotTranslate).toBe(true);
  });

  it("analyses the fixture the way a reviewer would expect", () => {
    const catalog = parseSourceFile("en.json", GAME_FILE);
    const byKey = new Map(catalog.entries.map((e) => [e.key, e]));

    const play = byKey.get("menu.play");
    expect(play?.role).toBe("menu");
    expect(play?.developerNote).toBe("Strings for the roguelike prototype");

    const hp = byKey.get("hud.hp");
    expect(hp?.placeholders.map((p) => p.token)).toEqual(["current", "max"]);
    expect(hp?.ambiguities.some((a) => a.kind === "gaming-slang")).toBe(true);

    const combo = byKey.get("hud.combo");
    expect(combo?.placeholders).toHaveLength(1);
    expect(combo?.placeholders[0]?.kind).toBe("double-brace");

    const timer = byKey.get("hud.timer");
    expect(timer?.placeholders[0]?.kind).toBe("printf");
    expect(timer?.ambiguities.some((a) => a.kind === "unit-or-word")).toBe(true);

    expect(byKey.get("hud.empty")?.doNotTranslate).toBe(true);

    const shopTitle = byKey.get("shop.title");
    expect(shopTitle?.developerNote).toBe("Header of the in-run shop");

    const legendary = byKey.get("shop.items[1].description");
    expect(legendary?.role).toBe("body");
    expect(
      legendary?.ambiguities.some((a) => a.kind === "gaming-slang"),
    ).toBe(true);

    const errorTitle = byKey.get("errors[0].title");
    expect(errorTitle?.path).toEqual(["errors", 0, "title"]);
  });

  it("keeps every entry key decodable back to its path", () => {
    const catalog = parseSourceFile("en.json", GAME_FILE);
    for (const entry of catalog.entries) {
      expect(decodeKey(entry.key)).toEqual(entry.path);
      expect(encodeKey(entry.path)).toBe(entry.key);
    }
  });
});

// ---------------------------------------------------------------------------
// Randomised structural fuzzing
// ---------------------------------------------------------------------------

/** Deterministic PRNG so a failure is always reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const NASTY_KEYS = [
  "plain",
  // Integer-like keys are the case a JS object cannot order on its own.
  "7",
  "12",
  "with.dot",
  "with[bracket]",
  "back\\slash",
  "",
  "0",
  "emoji🎮",
  "_comment",
  "@plain",
  "spaced key",
];

function randomTree(rand: () => number, depth: number): JsonValue {
  const roll = rand();
  if (depth <= 0 || roll < 0.35) {
    const leaf = rand();
    if (leaf < 0.55) return `str-${Math.floor(rand() * 1000)}`;
    if (leaf < 0.7) return Math.floor(rand() * 1000);
    if (leaf < 0.8) return rand() < 0.5;
    if (leaf < 0.9) return null;
    return rand() * 10;
  }
  if (roll < 0.65) {
    const length = Math.floor(rand() * 4);
    const out: JsonValue[] = [];
    for (let i = 0; i < length; i++) out.push(randomTree(rand, depth - 1));
    return out;
  }
  const out: { [k: string]: JsonValue } = {};
  const count = Math.floor(rand() * 5);
  for (let i = 0; i < count; i++) {
    const key = NASTY_KEYS[Math.floor(rand() * NASTY_KEYS.length)] ?? "k";
    out[`${key}${i}`] = randomTree(rand, depth - 1);
  }
  return out;
}

describe("structural fuzzing", () => {
  it("round-trips 200 random trees with adversarial keys", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = makeRandom(seed);
      const tree = { root: randomTree(rand, 5) } satisfies JsonValue;

      // Identity.
      expect(rebuildTree(tree, new Map())).toEqual(tree);

      // Full substitution touches exactly the string leaves the flattener saw.
      const entries = flattenJson(tree);
      const translations = new Map(
        entries.map((e) => [e.key, `T(${e.value})`]),
      );
      const rebuilt = rebuildTree(tree, translations);

      const seen = new Set(entries.map((e) => e.key));
      expect(seen.size).toBe(entries.length);
      for (const entry of entries) {
        expect(decodeKey(entry.key)).toEqual(entry.path);
      }

      // The only difference is the string leaves; JSON shape is preserved.
      const skeleton = (node: JsonValue): JsonValue => {
        if (typeof node === "string") return 0;
        if (Array.isArray(node)) return node.map(skeleton);
        if (node !== null && typeof node === "object") {
          const o: { [k: string]: JsonValue } = {};
          for (const k of Object.keys(node)) {
            const child = node[k];
            if (child !== undefined) o[k] = skeleton(child);
          }
          return o;
        }
        return node;
      };
      expect(JSON.stringify(skeleton(rebuilt))).toBe(
        JSON.stringify(skeleton(tree)),
      );
    }
  });

  it("survives a full parse/rebuild/serialize cycle for random trees", () => {
    for (let seed = 500; seed < 540; seed++) {
      const rand = makeRandom(seed);
      const tree = { root: randomTree(rand, 4) } satisfies JsonValue;
      const raw = `${JSON.stringify(tree, null, 2)}\n`;
      const catalog = parseSourceFile("en.json", raw);
      const output = serializeWithCatalogFormatting(
        catalog,
        rebuildTree(catalog.tree, new Map()),
      );
      expect(output).toBe(raw);
    }
  });
});
