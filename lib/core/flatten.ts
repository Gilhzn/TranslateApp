import type { JsonValue, StringEntry } from "@/lib/types";
import { encodeKey } from "./keys";
import { extractPlaceholders } from "./placeholders";
import { classifyNonTranslatable } from "./translatable";
import { inferRole } from "./roles";
import { detectAmbiguities } from "./ambiguity";

/**
 * Flattening and reconstruction.
 *
 * The contract for this pair of functions is total round-trip fidelity:
 * `rebuildTree(tree, new Map())` must deep-equal `tree`, and substituting
 * translations must change nothing but the string leaves that were substituted.
 * Everything else — key order, array length, numbers, booleans, nulls, empty
 * containers — is carried through untouched.
 */

/**
 * Level-scoped developer notes, in priority order. i18next and Chrome
 * extension catalogues both use leading-underscore sibling keys for context.
 */
const LEVEL_NOTE_KEYS = [
  "_context",
  "_comment",
  "_description",
  "_note",
] as const;

/**
 * Per-key companions: `@title` (Chrome-extension style) and `title_comment`
 * (i18next style) both document the sibling `title`.
 */
function companionNoteKeys(key: string): string[] {
  return [`@${key}`, `${key}_comment`, `${key}_note`];
}

function isPlainObject(
  value: JsonValue,
): value is { [k: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ObjectNoteContext {
  /** Note that applies to this level and everything below it. */
  levelNote: string | undefined;
  /** key -> note taken from a companion key. */
  perKey: Map<string, string>;
  /** Keys that are metadata and must never be emitted as entries. */
  metaKeys: Set<string>;
}

function readNoteContext(node: { [k: string]: JsonValue }): ObjectNoteContext {
  const metaKeys = new Set<string>();
  const perKey = new Map<string, string>();
  let levelNote: string | undefined;

  for (const noteKey of LEVEL_NOTE_KEYS) {
    const raw = node[noteKey];
    // A non-string `_comment` is real data (some catalogues nest under it), so
    // it stays translatable rather than being silently dropped.
    if (typeof raw === "string" && raw.trim().length > 0) {
      metaKeys.add(noteKey);
      if (levelNote === undefined) levelNote = raw.trim();
    }
  }

  for (const key of Object.keys(node)) {
    if (metaKeys.has(key)) continue;
    for (const companion of companionNoteKeys(key)) {
      if (companion === key) continue;
      const raw = node[companion];
      // Only treat the companion as metadata when the key it documents really
      // exists; an orphan `@foo` is ordinary content.
      if (typeof raw === "string" && raw.trim().length > 0) {
        metaKeys.add(companion);
        if (!perKey.has(key)) perKey.set(key, raw.trim());
      }
    }
  }

  return { levelNote, perKey, metaKeys };
}

function buildEntry(
  path: ReadonlyArray<string | number>,
  value: string,
  developerNote: string | undefined,
): StringEntry {
  const key = encodeKey(path);
  const placeholders = extractPlaceholders(value);
  const reason = classifyNonTranslatable(value, placeholders);
  const doNotTranslate = reason !== null;
  const role = inferRole(path, value);
  // Ambiguity analysis on machine tokens is pure noise — a URL containing the
  // word "steam" is not a brand decision.
  const ambiguities = doNotTranslate
    ? []
    : detectAmbiguities(key, value, role);

  const entry: StringEntry = {
    key,
    path: [...path],
    value,
    placeholders,
    role,
    ambiguities,
    doNotTranslate,
  };
  if (developerNote !== undefined) entry.developerNote = developerNote;
  return entry;
}

/**
 * Walk the tree in document order, emitting one {@link StringEntry} per string
 * leaf. Numbers, booleans, nulls and empty containers produce no entry but are
 * left in the tree for reconstruction.
 */
export function flattenJson(tree: JsonValue): StringEntry[] {
  const entries: StringEntry[] = [];
  const path: Array<string | number> = [];

  const visit = (node: JsonValue, inheritedNote: string | undefined): void => {
    if (typeof node === "string") {
      entries.push(buildEntry(path, node, inheritedNote));
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const child = node[i];
        if (child === undefined) continue;
        path.push(i);
        visit(child, inheritedNote);
        path.pop();
      }
      return;
    }
    if (isPlainObject(node)) {
      const ctx = readNoteContext(node);
      // A note attached to a section is useful to everything inside it, so it
      // propagates downward until a nearer note overrides it.
      const nextInherited = ctx.levelNote ?? inheritedNote;
      for (const key of Object.keys(node)) {
        if (ctx.metaKeys.has(key)) continue;
        const child = node[key];
        if (child === undefined) continue;
        path.push(key);
        visit(child, ctx.perKey.get(key) ?? nextInherited);
        path.pop();
      }
    }
    // Primitive non-strings: nothing to emit.
  };

  visit(tree, undefined);
  return entries;
}

/**
 * Rebuild a document from the original tree, substituting translated strings by
 * flattened key.
 *
 * The original tree — not the entry list — is the template, so anything the
 * flattener chose to skip (developer notes, numbers, booleans, nulls) survives
 * verbatim, and any key absent from `translations` keeps its source value.
 *
 * Caveat inherited from `JSON.parse`: JavaScript objects reorder integer-like
 * keys ("2" before "10"), so a source document using numeric string keys is
 * already reordered before this function ever sees it. The output is identical
 * to the parsed input in every case; byte-identity with the raw upload requires
 * an order-preserving parser, which the shared `JsonValue` type does not model.
 */
export function rebuildTree(
  templateTree: JsonValue,
  translations: ReadonlyMap<string, string>,
): JsonValue {
  const path: Array<string | number> = [];

  const rebuild = (node: JsonValue): JsonValue => {
    if (typeof node === "string") {
      const translated = translations.get(encodeKey(path));
      return translated === undefined ? node : translated;
    }
    if (Array.isArray(node)) {
      const out: JsonValue[] = new Array<JsonValue>(node.length);
      for (let i = 0; i < node.length; i++) {
        const child = node[i];
        path.push(i);
        // `child` can only be undefined for a sparse array, which JSON.parse
        // never produces; null is preserved as null by the branch below.
        out[i] = child === undefined ? null : rebuild(child);
        path.pop();
      }
      return out;
    }
    if (isPlainObject(node)) {
      const out: { [k: string]: JsonValue } = {};
      for (const key of Object.keys(node)) {
        const child = node[key];
        if (child === undefined) continue;
        path.push(key);
        out[key] = rebuild(child);
        path.pop();
      }
      return out;
    }
    return node;
  };

  return rebuild(templateTree);
}

/** Structural statistics, counted over the whole tree including metadata keys. */
export interface TreeStats {
  /** Every primitive leaf: strings, numbers, booleans and nulls. */
  totalLeaves: number;
  /** Deepest path length; a flat `{"a":"b"}` document has depth 1. */
  maxDepth: number;
}

export function collectTreeStats(tree: JsonValue): TreeStats {
  let totalLeaves = 0;
  let maxDepth = 0;

  const visit = (node: JsonValue, depth: number): void => {
    if (depth > maxDepth) maxDepth = depth;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (isPlainObject(node)) {
      for (const key of Object.keys(node)) {
        const child = node[key];
        if (child === undefined) continue;
        visit(child, depth + 1);
      }
      return;
    }
    totalLeaves += 1;
  };

  visit(tree, 0);
  return { totalLeaves, maxDepth };
}
