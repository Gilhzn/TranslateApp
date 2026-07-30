/**
 * The review table's row model.
 *
 * A `TranslatedEntry` is what the pipeline produces; a `ReviewRow` is what the
 * table needs to render and edit it — the entry plus the source-side analysis
 * (role, ambiguities, developer note) that lives on the `StringEntry`, plus the
 * developer's local override.
 *
 * Pure and React-free so the filtering, editing and export logic is testable
 * without a DOM.
 */

import { extractPlaceholders, inferRole } from "@/lib/core";
import { placeholderIdentity } from "@/lib/validate";
import type {
  AmbiguityFlag,
  EntryStatus,
  FitResult,
  Issue,
  LocaleCode,
  LocaleResult,
  Placeholder,
  SourceCatalog,
  StringEntry,
  TranslatedEntry,
  UiRole,
} from "@/lib/types";

export interface ReviewRow {
  /** Stable identity across filtering and re-sorting: `locale::key`. */
  id: string;
  locale: LocaleCode;
  key: string;
  path: ReadonlyArray<string | number>;
  role: UiRole;
  source: string;
  /** Current value — the developer's override when one exists. */
  target: string;
  /** What the model returned, kept so an edit can be reverted. */
  modelTarget: string;
  edited: boolean;
  status: EntryStatus;
  issues: Issue[];
  fit: FitResult | null;
  attempts: number;
  rationale?: string;
  developerNote?: string;
  ambiguities: AmbiguityFlag[];
  doNotTranslate: boolean;
  sourcePlaceholders: Placeholder[];
  targetPlaceholders: Placeholder[];
  /** Sibling keys, shown as UI context in the expanded row. */
  neighbors: string[];
}

/** Index a catalog by flattened key so a row can be enriched in O(1). */
export function indexCatalog(
  catalog: Pick<SourceCatalog, "entries">,
): Map<string, StringEntry> {
  const index = new Map<string, StringEntry>();
  for (const entry of catalog.entries) index.set(entry.key, entry);
  return index;
}

/** Sibling keys of `key` — everything sharing its parent path. */
function neighborsOf(key: string, all: readonly string[]): string[] {
  const cut = Math.max(key.lastIndexOf("."), key.lastIndexOf("["));
  const parent = cut === -1 ? "" : key.slice(0, cut);
  const out: string[] = [];
  for (const candidate of all) {
    if (candidate === key) continue;
    const candidateCut = Math.max(
      candidate.lastIndexOf("."),
      candidate.lastIndexOf("["),
    );
    const candidateParent = candidateCut === -1 ? "" : candidate.slice(0, candidateCut);
    if (candidateParent === parent) out.push(candidate);
    if (out.length >= 8) break;
  }
  return out;
}

export function buildRow(
  entry: TranslatedEntry,
  analysis: StringEntry | undefined,
  neighbors: string[],
): ReviewRow {
  const sourcePlaceholders =
    analysis?.placeholders ?? extractPlaceholders(entry.source);

  const row: ReviewRow = {
    id: `${entry.locale}::${entry.key}`,
    locale: entry.locale,
    key: entry.key,
    path: entry.path,
    role: analysis?.role ?? inferRole(entry.path, entry.source),
    source: entry.source,
    target: entry.target,
    modelTarget: entry.target,
    edited: false,
    status: entry.status,
    issues: entry.issues,
    fit: entry.fit,
    attempts: entry.attempts,
    ambiguities: analysis?.ambiguities ?? [],
    doNotTranslate: analysis?.doNotTranslate ?? false,
    sourcePlaceholders: [...sourcePlaceholders],
    targetPlaceholders: extractPlaceholders(entry.target),
    neighbors,
  };
  if (entry.rationale !== undefined) row.rationale = entry.rationale;
  if (analysis?.developerNote !== undefined) {
    row.developerNote = analysis.developerNote;
  }
  return row;
}

/**
 * Flatten every locale result into one row list.
 *
 * Locale order follows `results`, and within a locale the entries keep source
 * document order — the order the developer's file is written in, which is the
 * only ordering that lets them read the table as their own file.
 */
export function buildRows(
  catalog: Pick<SourceCatalog, "entries">,
  results: readonly LocaleResult[],
): ReviewRow[] {
  const index = indexCatalog(catalog);
  const keys = catalog.entries.map((e) => e.key);
  const neighborCache = new Map<string, string[]>();

  const rows: ReviewRow[] = [];
  for (const result of results) {
    for (const entry of result.entries) {
      let neighbors = neighborCache.get(entry.key);
      if (neighbors === undefined) {
        neighbors = neighborsOf(entry.key, keys);
        neighborCache.set(entry.key, neighbors);
      }
      rows.push(buildRow(entry, index.get(entry.key), neighbors));
    }
  }
  return rows;
}

/** Project a row back onto the contract type, for export and for sync. */
export function rowToEntry(row: ReviewRow): TranslatedEntry {
  const entry: TranslatedEntry = {
    key: row.key,
    path: row.path,
    source: row.source,
    target: row.target,
    locale: row.locale,
    status: row.status,
    issues: row.issues,
    fit: row.fit,
    attempts: row.attempts,
  };
  if (row.rationale !== undefined) entry.rationale = row.rationale;
  return entry;
}

/**
 * A locale result carrying the developer's edits, ready to serialise.
 *
 * Stats are recomputed rather than copied: exporting a file whose header says
 * "3 failed" after the developer fixed all three would be a lie.
 */
export function resultWithEdits(
  result: LocaleResult,
  rows: readonly ReviewRow[],
): LocaleResult {
  const byKey = new Map<string, ReviewRow>();
  for (const row of rows) {
    if (row.locale === result.locale) byKey.set(row.key, row);
  }

  const entries = result.entries.map((entry) => {
    const row = byKey.get(entry.key);
    return row === undefined ? entry : rowToEntry(row);
  });

  return { ...result, entries, stats: statsFor(entries, result.stats) };
}

function statsFor(
  entries: readonly TranslatedEntry[],
  previous: LocaleResult["stats"],
): LocaleResult["stats"] {
  let passed = 0;
  let flagged = 0;
  let failed = 0;
  let ratioSum = 0;
  let ratioCount = 0;

  for (const entry of entries) {
    if (entry.status === "passed") passed += 1;
    else if (entry.status === "flagged") flagged += 1;
    else if (entry.status === "failed") failed += 1;
    if (entry.fit !== null) {
      ratioSum += entry.fit.ratio;
      ratioCount += 1;
    }
  }

  return {
    total: entries.length,
    passed,
    flagged,
    failed,
    // Repairs happened during translation; edits cannot change that history.
    overflowRepaired: previous.overflowRepaired,
    averageRatio: ratioCount === 0 ? 0 : Math.round((ratioSum / ratioCount) * 1000) / 1000,
  };
}

// ---------------------------------------------------------------------------
// Placeholder inventory
// ---------------------------------------------------------------------------

export interface PlaceholderDiff {
  /** Present on both sides, keyed by the validator's own identity rule. */
  matched: Placeholder[];
  /** In the source, absent from the translation — a runtime hole. */
  missing: Placeholder[];
  /** Invented by the translation — a literal `{count}` in the UI. */
  added: Placeholder[];
}

/**
 * Compare the two placeholder inventories using the *validator's* identity
 * rule, so the panel can never disagree with the issue list beside it.
 */
export function diffPlaceholders(
  source: readonly Placeholder[],
  target: readonly Placeholder[],
): PlaceholderDiff {
  const targetCounts = new Map<string, number>();
  for (const p of target) {
    const id = placeholderIdentity(p);
    targetCounts.set(id, (targetCounts.get(id) ?? 0) + 1);
  }

  const matched: Placeholder[] = [];
  const missing: Placeholder[] = [];
  const consumed = new Map<string, number>();

  for (const p of source) {
    const id = placeholderIdentity(p);
    const used = consumed.get(id) ?? 0;
    if (used < (targetCounts.get(id) ?? 0)) {
      consumed.set(id, used + 1);
      matched.push(p);
    } else {
      missing.push(p);
    }
  }

  const sourceCounts = new Map<string, number>();
  for (const p of source) {
    const id = placeholderIdentity(p);
    sourceCounts.set(id, (sourceCounts.get(id) ?? 0) + 1);
  }

  const added: Placeholder[] = [];
  const seen = new Map<string, number>();
  for (const p of target) {
    const id = placeholderIdentity(p);
    const index = seen.get(id) ?? 0;
    seen.set(id, index + 1);
    if (index >= (sourceCounts.get(id) ?? 0)) added.push(p);
  }

  return { matched, missing, added };
}

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

export const REVIEW_STATUSES: readonly EntryStatus[] = Object.freeze([
  "passed",
  "flagged",
  "failed",
  "pending",
  "translating",
  "repairing",
]);

/** Statuses a completed job can actually show in the table. */
export const TERMINAL_STATUSES: readonly EntryStatus[] = Object.freeze([
  "passed",
  "flagged",
  "failed",
]);
