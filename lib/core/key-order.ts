import type { JsonValue } from "@/lib/types";
import { encodeKey } from "./keys";

/**
 * Source key order.
 *
 * JavaScript objects are not order-faithful containers: the ECMAScript own
 * property order rule puts integer-index keys first, in ascending numeric
 * order, ahead of every string key in insertion order. So the moment a
 * document like
 *
 *     { "items": { "101": "Iron Sword", "12": "Wooden Shield", "7": "Potion" } }
 *
 * becomes a plain object, its authored order is gone — `Object.keys` reports
 * `["7", "12", "101"]` and nothing downstream can recover the original. Real
 * locale files hit this constantly: item/level catalogues keyed by id, HTTP
 * error maps ("404", "500"), and plural maps that mix "0" with "one"/"other".
 *
 * Key order is therefore tracked *out of band*, next to the tree rather than
 * inside it:
 *
 * - a {@link KeyOrderMap} maps an encoded node path (see `keys.ts`; `""` is the
 *   root) to that object's keys in source order. It is produced by the
 *   order-preserving reader and carried on the catalog, so it can be inspected,
 *   passed across module boundaries and re-attached to a tree later.
 * - a module-local `WeakMap` additionally remembers the order by *node
 *   identity*, which means a caller holding nothing but a `JsonValue` still
 *   emits the right order without threading the map through every signature.
 *   Entries die with their nodes, so nothing leaks.
 *
 * Both are advisory: {@link orderKeys} never lets a recorded order drop or
 * duplicate a key that is actually present. A stale or foreign order degrades
 * to "best effort ordering", never to data loss.
 */

/** Encoded node path -> that object's keys in source order. */
export type KeyOrderMap = ReadonlyMap<string, readonly string[]>;

/**
 * A {@link KeyOrderMap} in a form that survives `JSON.stringify` — a `Map`
 * serialises to `{}`, which would drop the order at exactly the module
 * boundary (API route -> browser) where it matters most.
 */
export type SerializedKeyOrder = ReadonlyArray<
  readonly [string, readonly string[]]
>;

const NODE_KEY_ORDER = new WeakMap<object, readonly string[]>();

/**
 * Remember the source order of an object node's keys by node identity.
 * `keys` is stored by reference and must not be mutated afterwards.
 */
export function registerKeyOrder(
  node: object,
  keys: readonly string[],
): void {
  NODE_KEY_ORDER.set(node, keys);
}

/** The order registered for this exact node, if any. */
export function recordedKeyOrder(node: object): readonly string[] | undefined {
  return NODE_KEY_ORDER.get(node);
}

/**
 * Find the recorded order for `node`, preferring an explicit map (looked up by
 * the node's encoded path) over the identity registry.
 *
 * The explicit map wins because a caller that passes one is asserting an order
 * for *this* tree — e.g. a catalog rehydrated from JSON, whose nodes are new
 * objects the identity registry has never seen.
 */
export function resolveKeyOrder(
  node: object,
  path: ReadonlyArray<string | number>,
  keyOrder: KeyOrderMap | undefined,
): readonly string[] | undefined {
  if (keyOrder !== undefined) {
    // Only pay for the path encoding when there is a map to look into.
    const byPath = keyOrder.get(encodeKey(path));
    if (byPath !== undefined) return byPath;
  }
  return NODE_KEY_ORDER.get(node);
}

/**
 * The node's own keys, in recorded source order.
 *
 * Reconciles the recorded order against reality: recorded keys that are no
 * longer present are dropped, keys present but unrecorded are appended in
 * `Object.keys` order, and duplicates in the recorded list are collapsed. The
 * result is always a permutation of `Object.keys(node)`.
 */
export function orderKeys(
  node: { [k: string]: JsonValue },
  recorded: readonly string[] | undefined,
): string[] {
  const actual = Object.keys(node);
  if (recorded === undefined || recorded.length === 0) return actual;

  const present = new Set(actual);
  const taken = new Set<string>();
  const out: string[] = [];
  for (const key of recorded) {
    if (!present.has(key) || taken.has(key)) continue;
    taken.add(key);
    out.push(key);
  }
  if (out.length !== actual.length) {
    for (const key of actual) {
      if (!taken.has(key)) out.push(key);
    }
  }
  return out;
}

/** Convert a key-order map into something JSON-safe. */
export function toSerializableKeyOrder(map: KeyOrderMap): SerializedKeyOrder {
  return [...map].map(([path, keys]) => [path, [...keys]] as const);
}

/** Inverse of {@link toSerializableKeyOrder}. */
export function keyOrderFromEntries(entries: SerializedKeyOrder): KeyOrderMap {
  return new Map(entries.map(([path, keys]) => [path, [...keys]]));
}

/**
 * Assign a member without the `__proto__` trap.
 *
 * `JSON.parse` creates `__proto__` as an ordinary own data property, so locale
 * files really can contain that key; a plain `obj[key] = value` would instead
 * reassign the prototype and silently drop the member.
 */
export function setMember(
  target: { [k: string]: JsonValue },
  key: string,
  value: JsonValue,
): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  }
  target[key] = value;
}
