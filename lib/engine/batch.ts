/**
 * Batching.
 *
 * Two forces pull against each other:
 *
 *   - Bigger batches are cheaper and more coherent. The model sees siblings
 *     together, so "Save" and "Saving…" get resolved as a pair rather than
 *     independently, and the system prompt is amortised over more strings.
 *   - Smaller batches are safer. One malformed response costs a whole batch,
 *     and long outputs are where models start dropping keys.
 *
 * The compromise: pack up to a token ceiling, but never split a *sibling group*
 * across two batches unless the group alone exceeds the ceiling. Siblings are
 * the unit of context — `menu.file.save` is only disambiguated by
 * `menu.file.open` sitting next to it — so keeping them together is worth more
 * than filling every batch to the brim.
 */

import type { ProviderRequest, TranslationUnit } from "@/lib/types";

export interface BatchOptions {
  /** Hard cap on units per batch. */
  maxUnits?: number;
  /** Soft cap on estimated prompt tokens contributed by the unit block. */
  maxTokens?: number;
  /** Characters per token used by the estimator. */
  charsPerToken?: number;
}

const DEFAULT_MAX_UNITS = 40;
const DEFAULT_MAX_TOKENS = 6000;
const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * Fixed scaffolding a unit costs regardless of its content: the key, role
 * sentence, budget sentence, and the labels around them. Measured against the
 * blocks `buildUserPrompt` actually emits, rounded up.
 */
const UNIT_OVERHEAD_CHARS = 420;

/** Rough token cost of one unit inside the user prompt. */
export function estimateUnitTokens(
  unit: TranslationUnit,
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): number {
  let chars = UNIT_OVERHEAD_CHARS;
  chars += unit.key.length;
  // The model has to read the source and write a translation of it, so the
  // source is counted twice — output tokens are the scarcer budget.
  chars += unit.source.length * 2;
  chars += unit.budget.rationale.length;
  for (const placeholder of unit.placeholders) chars += placeholder.raw.length + 24;
  for (const flag of unit.ambiguities) chars += flag.note.length + 32;
  for (const neighbor of unit.neighbors.slice(0, 8)) chars += neighbor.length + 2;
  if (unit.developerNote !== undefined) chars += unit.developerNote.length + 16;
  if (unit.repairFeedback !== undefined) chars += unit.repairFeedback.length + 240;
  if (unit.previousAttempt !== undefined) chars += unit.previousAttempt.length + 32;
  return Math.max(1, Math.ceil(chars / Math.max(1, charsPerToken)));
}

/**
 * The sibling group a key belongs to: its parent path.
 *
 *   "menu.file.save"   -> "menu.file"
 *   "errors[0].title"  -> "errors[0]"
 *   "errors[0]"        -> "errors"
 *   "title"            -> ""            (root)
 *
 * Escaped separators (`\.`) are ignored, matching the key encoding used by the
 * parser when a source object literally contains a dot in a key name.
 */
export function siblingGroupOf(key: string): string {
  let cut = -1;
  for (let i = 0; i < key.length; i += 1) {
    const char = key[i];
    if (char === "\\") {
      i += 1; // skip the escaped character
      continue;
    }
    if (char === "." || char === "[") cut = i;
  }
  return cut <= 0 ? "" : key.slice(0, cut);
}

/**
 * Split units into batches that respect the ceilings while keeping siblings
 * together. Input order is preserved; every unit appears exactly once.
 */
export function chunkUnits(
  units: readonly TranslationUnit[],
  options: BatchOptions = {},
): TranslationUnit[][] {
  const maxUnits = Math.max(1, options.maxUnits ?? DEFAULT_MAX_UNITS);
  const maxTokens = Math.max(1, options.maxTokens ?? DEFAULT_MAX_TOKENS);
  const charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;

  if (units.length === 0) return [];

  const groups = groupBySibling(units);
  const batches: TranslationUnit[][] = [];
  let current: TranslationUnit[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (current.length > 0) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
  };

  for (const group of groups) {
    const groupTokens = group.reduce(
      (sum, unit) => sum + estimateUnitTokens(unit, charsPerToken),
      0,
    );

    // A group that cannot fit on its own is packed unit-by-unit. Contiguity is
    // preserved, so siblings still land next to each other across the split.
    if (group.length > maxUnits || groupTokens > maxTokens) {
      flush();
      for (const unit of group) {
        const cost = estimateUnitTokens(unit, charsPerToken);
        if (
          current.length > 0 &&
          (current.length + 1 > maxUnits || currentTokens + cost > maxTokens)
        ) {
          flush();
        }
        current.push(unit);
        currentTokens += cost;
      }
      continue;
    }

    if (
      current.length > 0 &&
      (current.length + group.length > maxUnits ||
        currentTokens + groupTokens > maxTokens)
    ) {
      flush();
    }
    current.push(...group);
    currentTokens += groupTokens;
  }

  flush();
  return batches;
}

/** Units grouped by sibling path, groups ordered by first appearance. */
function groupBySibling(
  units: readonly TranslationUnit[],
): TranslationUnit[][] {
  const order: string[] = [];
  const byGroup = new Map<string, TranslationUnit[]>();

  for (const unit of units) {
    const group = siblingGroupOf(unit.key);
    const existing = byGroup.get(group);
    if (existing === undefined) {
      order.push(group);
      byGroup.set(group, [unit]);
    } else {
      existing.push(unit);
    }
  }

  return order.map((group) => byGroup.get(group) ?? []);
}

/** Same split, expressed as complete provider requests ready to dispatch. */
export function batchRequests(
  request: ProviderRequest,
  options: BatchOptions = {},
): ProviderRequest[] {
  return chunkUnits(request.units, options).map((units) => ({
    ...request,
    units,
  }));
}
