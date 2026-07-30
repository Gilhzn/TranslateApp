/**
 * Catalog entries → translation units.
 *
 * This is where the four libraries are stitched into one object the provider
 * can reason about: the parser's role, placeholders and ambiguities, the layout
 * engine's budget and allowed width, and the sibling keys that disambiguate
 * "Save" the verb from "Save" the noun.
 *
 * Nothing is recomputed that the parser already computed. The one thing added
 * here is *neighbour selection*, which the parser has no opinion about.
 */

import { siblingGroupOf } from "@/lib/engine";
import { planLength } from "@/lib/layout";
import type {
  LocaleProfile,
  StringEntry,
  TranslationUnit,
} from "@/lib/types";

/**
 * Sibling keys shown to the model. The prompt engine caps its own rendering at
 * eight, and `estimateUnitTokens` bills for eight, so sending more would inflate
 * the batch estimate for context that is never printed.
 */
export const MAX_NEIGHBORS = 8;

export interface PreparedUnit {
  entry: StringEntry;
  unit: TranslationUnit;
}

export interface PreparedCatalog {
  /** Entries that need a model call, in source order. */
  units: PreparedUnit[];
  /** Entries the parser marked `doNotTranslate`; emitted verbatim. */
  passthrough: StringEntry[];
}

/**
 * Nearest siblings for every key, in source order.
 *
 * "Nearest" rather than "first N" on purpose. A settings screen with forty
 * labels under `settings.*` would otherwise show every string the same eight
 * neighbours — the alphabetically-first ones — which is context for the first
 * unit and noise for the other thirty-nine. A window centred on the key itself
 * gives each string the strings it actually sits next to in the UI.
 */
export function neighborKeys(
  entries: readonly StringEntry[],
  max: number = MAX_NEIGHBORS,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    const group = siblingGroupOf(entry.key);
    const bucket = groups.get(group);
    if (bucket === undefined) groups.set(group, [entry.key]);
    else bucket.push(entry.key);
  }

  const out = new Map<string, string[]>();
  for (const keys of groups.values()) {
    for (let i = 0; i < keys.length; i += 1) {
      const self = keys[i];
      if (self === undefined) continue;
      out.set(self, windowAround(keys, i, max));
    }
  }
  return out;
}

function windowAround(
  keys: readonly string[],
  index: number,
  max: number,
): string[] {
  if (keys.length <= 1 || max <= 0) return [];
  const span = Math.min(max + 1, keys.length);
  const half = Math.floor(max / 2);
  // Clamp the window inside the group, then slide it back so a key near either
  // end still sees `max` neighbours rather than half of them.
  let start = Math.min(Math.max(0, index - half), keys.length - span);
  if (start < 0) start = 0;
  const end = start + span;

  const out: string[] = [];
  for (let i = start; i < end; i += 1) {
    if (i === index) continue;
    const key = keys[i];
    if (key !== undefined) out.push(key);
  }
  return out;
}

/**
 * Build the unit list for one target locale.
 *
 * Budgets are per-locale — German gets a different allowance than Japanese for
 * the same button — so this runs once per locale rather than once per catalog.
 */
export function prepareUnits(
  entries: readonly StringEntry[],
  profile: LocaleProfile,
): PreparedCatalog {
  const neighbors = neighborKeys(entries);
  const units: PreparedUnit[] = [];
  const passthrough: StringEntry[] = [];

  for (const entry of entries) {
    if (entry.doNotTranslate) {
      passthrough.push(entry);
      continue;
    }

    // `planLength` measures the source once and returns both halves the unit
    // needs; calling `budgetForRole` and `allowedWidthFor` separately would
    // measure it twice for the same numbers.
    const plan = planLength(entry.value, entry.role, profile);

    const unit: TranslationUnit = {
      key: entry.key,
      source: entry.value,
      role: entry.role,
      // Copied so a repair pass that rewrites a unit cannot alias the parsed
      // catalog, which is reused across every target locale.
      placeholders: [...entry.placeholders],
      ambiguities: [...entry.ambiguities],
      budget: plan.budget,
      allowedWidth: plan.allowedWidth,
      neighbors: neighbors.get(entry.key) ?? [],
    };
    if (entry.developerNote !== undefined) {
      unit.developerNote = entry.developerNote;
    }

    units.push({ entry, unit });
  }

  return { units, passthrough };
}

/** A repair re-issue of `unit`, carrying why the last attempt was rejected. */
export function repairUnit(
  unit: TranslationUnit,
  previousAttempt: string,
  repairFeedback: string,
): TranslationUnit {
  return { ...unit, previousAttempt, repairFeedback };
}
