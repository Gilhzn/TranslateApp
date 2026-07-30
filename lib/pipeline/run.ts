/**
 * The autonomous execution loop.
 *
 * One catalog, one locale, from `StringEntry[]` to a validated `LocaleResult`:
 *
 *   1. build units (role, placeholders, ambiguities, budget, neighbours)
 *   2. batch them, keeping siblings together
 *   3. call the provider, several batches at a time
 *   4. mechanical fixes → validators → fit
 *   5. re-issue only the failing units, with feedback, up to the repair budget
 *   6. resolve a terminal status per entry
 *   7. rebuild the tree and prove it is structurally identical to the source
 *
 * The loop is what makes this a product rather than four libraries: every step
 * is somebody else's function, and none of them are re-implemented here.
 *
 * Two invariants this file is responsible for:
 *
 *   - A failed entry never puts an empty or partial string into the output
 *     tree. It keeps its SOURCE value. Shipping English is a bug report;
 *     shipping an empty button is a broken app.
 *   - A structural divergence is a hard, job-level error. The single promise
 *     this tool makes is that the file that comes back has the same shape as
 *     the file that went in.
 */

import { rebuildTree, type KeyOrderMap } from "@/lib/core";
import { chunkUnits, type BatchOptions } from "@/lib/engine";
import { evaluateFit, getLocaleProfile } from "@/lib/layout";
import {
  applyMechanicalFixes,
  assertStructuralParity,
  budgetExhaustedIssue,
  buildRepairFeedback,
  issue,
  needsRepair,
  resolveFinalStatus,
  validateTranslation,
  type ValidationContext,
} from "@/lib/validate";
import type {
  FitResult,
  Issue,
  JsonValue,
  LocaleCode,
  LocaleResult,
  ProviderRequest,
  SourceCatalog,
  StringEntry,
  TranslatedEntry,
  TranslationJob,
  TranslationProvider,
  TranslationSettings,
  TranslationUnit,
} from "@/lib/types";
import { JobAbortedError, StructuralIntegrityError, throwIfAborted } from "./errors";
import { mapPool, withAbort } from "./pool";
import { ProgressTracker, type ProgressListener } from "./progress";
import { prepareUnits, repairUnit, type PreparedUnit } from "./units";

/**
 * A catalog the runner can execute.
 *
 * `keyOrder` is the `ParsedCatalog` extension: `SourceCatalog` is frozen and has
 * nowhere to put it, but without it a rebuilt object re-sorts integer-like keys
 * and the parity check fails on a file the pipeline handled perfectly.
 */
export type RunnableCatalog = SourceCatalog & { readonly keyOrder?: KeyOrderMap };

/** Signature of `rebuildTree`; injectable so parity enforcement is testable. */
export type RebuildFn = (
  template: JsonValue,
  translations: ReadonlyMap<string, string>,
  keyOrder?: KeyOrderMap,
) => JsonValue;

export const DEFAULT_BATCH_CONCURRENCY = 4;
export const DEFAULT_LOCALE_CONCURRENCY = 3;
/** Upper bound on repair passes, whatever the settings ask for. */
export const REPAIR_ATTEMPT_CEILING = 6;

export interface RunLocaleOptions {
  catalog: RunnableCatalog;
  settings: TranslationSettings;
  locale: LocaleCode;
  provider: TranslationProvider;
  signal?: AbortSignal | undefined;
  progress?: ProgressTracker | undefined;
  batch?: BatchOptions | undefined;
  batchConcurrency?: number | undefined;
  /**
   * Test seam for fault injection. Production always uses `rebuildTree`; the
   * parity check exists precisely because a bug here must not ship, and the
   * only way to prove the check fires is to hand it a broken rebuilder.
   */
  rebuild?: RebuildFn | undefined;
}

/** Mutable per-entry state while the repair loop runs. */
interface EntryState {
  entry: StringEntry;
  unit: TranslationUnit;
  /** Last attempt after mechanical fixes; `null` until the provider answers. */
  attempt: string | null;
  issues: Issue[];
  fit: FitResult | null;
  attempts: number;
  rationale: string | undefined;
  /** True when any pass produced an overflowing translation. */
  sawOverflow: boolean;
  settled: boolean;
}

export async function runLocale(options: RunLocaleOptions): Promise<LocaleResult> {
  const {
    catalog,
    settings,
    locale,
    provider,
    signal,
    batch,
    batchConcurrency = DEFAULT_BATCH_CONCURRENCY,
    rebuild = rebuildTree,
  } = options;

  const progress = options.progress ?? new ProgressTracker(catalog.entries.length);
  const profile = getLocaleProfile(locale);
  const maxRepairs = clampRepairs(settings.maxRepairAttempts);

  throwIfAborted(signal);
  progress.setPhase(
    "analyzing",
    locale,
    `Analysing ${catalog.entries.length} strings for ${profile.name}.`,
  );

  const prepared = prepareUnits(catalog.entries, profile);
  const states = new Map<string, EntryState>();
  for (const item of prepared.units) {
    states.set(item.unit.key, newState(item));
  }

  if (prepared.passthrough.length > 0) {
    // Machine data (URLs, tokens, empty strings) is done the moment it is
    // recognised; counting it as complete now keeps the bar honest.
    progress.advance(
      prepared.passthrough.length,
      locale,
      `${prepared.passthrough.length} non-translatable value(s) pass through verbatim.`,
    );
  }

  const localeIssues: Issue[] = [];
  const seenLocaleIssues = new Set<string>();
  const recordLocaleIssue = (candidate: Issue): void => {
    const signature = `${candidate.code}|${candidate.message}`;
    if (seenLocaleIssues.has(signature)) return;
    seenLocaleIssues.add(signature);
    localeIssues.push(candidate);
  };

  let pending: TranslationUnit[] = prepared.units.map((item) => item.unit);

  for (let pass = 0; pending.length > 0 && pass <= maxRepairs; pass += 1) {
    throwIfAborted(signal);

    const isRepair = pass > 0;
    progress.setPhase(
      isRepair ? "repairing" : "translating",
      locale,
      isRepair
        ? `Repair pass ${pass} of ${maxRepairs}: re-issuing ${pending.length} string(s) for ${profile.name}.`
        : `Translating ${pending.length} string(s) into ${profile.name}.`,
    );

    const batches = chunkUnits(pending, batch ?? {});
    const responses = await mapPool(
      batches,
      batchConcurrency,
      async (units) => {
        // Re-checked immediately before the call so a cancellation that lands
        // while earlier batches were in flight never buys another request.
        throwIfAborted(signal);
        const request: ProviderRequest = {
          locale: profile,
          sourceLocale: settings.sourceLocale,
          tone: settings.tone,
          productContext: settings.productContext,
          glossary: settings.glossary,
          units,
        };
        // The signal is handed to the provider AND raced against its promise:
        // both bundled providers honour it, but a custom one that does not
        // would otherwise hold a cancelled job open for its whole HTTP timeout.
        return withAbort(provider.translate(request, signal), signal);
      },
      { signal },
    );

    const nextPending: TranslationUnit[] = [];
    let settledThisPass = 0;

    for (let index = 0; index < batches.length; index += 1) {
      const units = batches[index];
      const response = responses[index];
      if (units === undefined || response === undefined) continue;

      for (const batchIssue of response.issues) recordLocaleIssue(batchIssue);
      const blocking = response.issues.filter((i) => i.severity === "error");
      const byKey = new Map(response.translations.map((t) => [t.key, t]));

      for (const unit of units) {
        const state = states.get(unit.key);
        if (state === undefined || state.settled) continue;
        state.attempts += 1;

        const translation = byKey.get(unit.key);
        if (translation === undefined) {
          // Nothing came back for this key. There is no attempt to validate and
          // no feedback a re-prompt could act on, so it settles as failed with
          // whatever the provider said about the batch.
          state.issues =
            blocking.length > 0
              ? blocking.map((i) => withKey(i, unit.key))
              : [missingTranslationIssue(unit.key, provider.id)];
          state.fit = null;
          state.settled = true;
          settledThisPass += 1;
          continue;
        }

        const fixed = applyMechanicalFixes(state.entry.value, translation.target);
        // The fit is always measured so the review table can show real widths,
        // but it is only *enforced* when the developer asked for it.
        const fit = evaluateFit(state.entry.value, fixed.text, state.entry.role, profile);
        const enforced = settings.enforceLayout ? fit : null;
        const issues = validateTranslation(
          state.entry.value,
          fixed.text,
          enforced,
          validationContext(state.entry, locale, settings),
        );

        state.attempt = fixed.text;
        state.fit = fit;
        state.issues = issues;
        state.rationale = translation.rationale;
        if (fit.verdict === "overflow") state.sawOverflow = true;

        if (!needsRepair(issues, enforced)) {
          state.settled = true;
          settledThisPass += 1;
          continue;
        }

        if (pass >= maxRepairs) {
          state.issues = [
            ...issues,
            budgetExhaustedIssue(unit.key, state.attempts, maxRepairs),
          ];
          state.settled = true;
          settledThisPass += 1;
          continue;
        }

        nextPending.push(
          repairUnit(
            unit,
            fixed.text,
            buildRepairFeedback(unit, fixed.text, issues, enforced),
          ),
        );
      }
    }

    if (settledThisPass > 0) {
      progress.advance(
        settledThisPass,
        locale,
        `${progress.completedUnits} of ${progress.totalUnits} strings resolved.`,
      );
    }
    pending = nextPending;
  }

  throwIfAborted(signal);
  progress.setPhase(
    "validating",
    locale,
    `Verifying the ${profile.name} catalogue against the source structure.`,
  );

  const entries = assembleEntries(
    catalog.entries,
    states,
    locale,
    settings.enforceLayout,
  );
  const tree = rebuild(catalog.tree, emittedValues(entries), catalog.keyOrder);

  const parity = assertStructuralParity(catalog.tree, tree);
  if (parity.length > 0) throw new StructuralIntegrityError(locale, parity);

  return {
    locale,
    entries,
    tree,
    issues: localeIssues,
    stats: computeStats(entries, states),
  };
}

// ---------------------------------------------------------------------------
// Job level
// ---------------------------------------------------------------------------

export interface RunJobOptions {
  catalog: RunnableCatalog;
  settings: TranslationSettings;
  provider: TranslationProvider;
  jobId?: string | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ProgressListener | undefined;
  onLocaleComplete?: ((result: LocaleResult) => void) | undefined;
  localeConcurrency?: number | undefined;
  batchConcurrency?: number | undefined;
  batch?: BatchOptions | undefined;
  rebuild?: RebuildFn | undefined;
}

/**
 * Translate one catalog into every target locale.
 *
 * Locales are independent, so they run concurrently under their own bound;
 * inside each locale the batches run concurrently under theirs. The product of
 * the two is the real ceiling on in-flight provider calls.
 */
export async function runJob(options: RunJobOptions): Promise<TranslationJob> {
  const {
    catalog,
    settings,
    provider,
    signal,
    localeConcurrency = DEFAULT_LOCALE_CONCURRENCY,
    batchConcurrency = DEFAULT_BATCH_CONCURRENCY,
    batch,
    rebuild,
  } = options;

  const locales = dedupeLocales(settings.targetLocales);
  const startedAt = Date.now();
  const totalUnits = catalog.entries.length * locales.length;
  const progress = new ProgressTracker(totalUnits, options.onProgress);
  const jobId = options.jobId ?? newJobId();

  progress.setPhase(
    "queued",
    null,
    locales.length === 0
      ? "No target locales were selected."
      : `Queued ${catalog.entries.length} strings × ${locales.length} locale(s).`,
  );

  const results: LocaleResult[] = [];
  const issues: Issue[] = [];

  try {
    const completed = await mapPool(
      locales,
      localeConcurrency,
      async (locale) => {
        const result = await runLocale({
          catalog,
          settings,
          locale,
          provider,
          signal,
          progress,
          batch,
          batchConcurrency,
          rebuild,
        });
        options.onLocaleComplete?.(result);
        return result;
      },
      { signal },
    );
    results.push(...completed);
  } catch (error) {
    progress.setPhase(
      "error",
      null,
      error instanceof JobAbortedError
        ? "The job was cancelled."
        : `The job failed: ${messageOf(error)}`,
    );
    throw error;
  }

  const seen = new Set<string>();
  for (const result of results) {
    for (const localeIssue of result.issues) {
      const signature = `${localeIssue.code}|${localeIssue.message}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      issues.push(localeIssue);
    }
  }

  progress.setPhase(
    "complete",
    null,
    `Translated ${catalog.entries.length} strings into ${results.length} locale(s).`,
  );

  return {
    id: jobId,
    catalog,
    settings,
    results,
    progress: progress.snapshot(null, "Complete."),
    issues,
    startedAt,
    finishedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function newState(item: PreparedUnit): EntryState {
  return {
    entry: item.entry,
    unit: item.unit,
    attempt: null,
    issues: [],
    fit: null,
    attempts: 0,
    rationale: undefined,
    sawOverflow: false,
    settled: false,
  };
}

function validationContext(
  entry: StringEntry,
  locale: LocaleCode,
  settings: TranslationSettings,
): ValidationContext {
  return {
    key: entry.key,
    role: entry.role,
    locale,
    sourceLocale: settings.sourceLocale,
    doNotTranslate: entry.doNotTranslate,
    glossary: settings.glossary,
    ambiguities: entry.ambiguities,
    sourcePlaceholders: entry.placeholders,
  };
}

function withKey(candidate: Issue, key: string): Issue {
  return candidate.key === key ? candidate : { ...candidate, key };
}

function missingTranslationIssue(key: string, providerId: string): Issue {
  return issue(
    "provider-error",
    "error",
    `The ${providerId} provider returned no translation for this key, so the source string was kept.`,
    { key, detail: { provider: providerId, reason: "missing-key" } },
  );
}

/**
 * The string the review table shows.
 *
 * The model's own output, so a developer can see and fix a near miss — with one
 * exception: a blank answer for a non-blank source is a hole in the UI, never
 * something to display as a translation, so the source stands in.
 */
function reviewTarget(state: EntryState): string {
  const attempt = state.attempt;
  if (attempt === null) return state.entry.value;
  if (attempt.trim().length === 0 && state.entry.value.trim().length > 0) {
    return state.entry.value;
  }
  return attempt;
}

function assembleEntries(
  sourceEntries: readonly StringEntry[],
  states: ReadonlyMap<string, EntryState>,
  locale: LocaleCode,
  enforceLayout: boolean,
): TranslatedEntry[] {
  const out: TranslatedEntry[] = [];

  for (const entry of sourceEntries) {
    const state = states.get(entry.key);

    if (state === undefined) {
      // `doNotTranslate`: emitted verbatim, and that IS the correct output.
      out.push({
        key: entry.key,
        path: entry.path,
        source: entry.value,
        target: entry.value,
        locale,
        status: "passed",
        issues: [],
        fit: null,
        attempts: 0,
      });
      continue;
    }

    const translated: TranslatedEntry = {
      key: entry.key,
      path: entry.path,
      source: entry.value,
      target: reviewTarget(state),
      locale,
      // The layout verdict is reported either way, but it only decides the
      // status when the developer asked for length enforcement.
      status: resolveFinalStatus(state.issues, enforceLayout ? state.fit : null),
      issues: state.issues,
      fit: state.fit,
      attempts: state.attempts,
    };
    if (state.rationale !== undefined) translated.rationale = state.rationale;
    out.push(translated);
  }

  return out;
}

/**
 * What goes into the emitted tree.
 *
 * A failed entry contributes its SOURCE value, not its rejected attempt. This
 * is the rule the whole pipeline exists to enforce: an overflowing, empty or
 * placeholder-broken string in a shipped catalogue is a production defect,
 * whereas an untranslated English string is a visible, harmless gap.
 */
function emittedValues(entries: readonly TranslatedEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of entries) {
    out.set(entry.key, entry.status === "failed" ? entry.source : entry.target);
  }
  return out;
}

function computeStats(
  entries: readonly TranslatedEntry[],
  states: ReadonlyMap<string, EntryState>,
): LocaleResult["stats"] {
  let passed = 0;
  let flagged = 0;
  let failed = 0;
  let overflowRepaired = 0;
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

    const state = states.get(entry.key);
    if (
      state !== undefined &&
      state.sawOverflow &&
      state.fit !== null &&
      state.fit.verdict !== "overflow"
    ) {
      overflowRepaired += 1;
    }
  }

  return {
    total: entries.length,
    passed,
    flagged,
    failed,
    overflowRepaired,
    averageRatio:
      ratioCount === 0 ? 1 : Math.round((ratioSum / ratioCount) * 1000) / 1000,
  };
}

function clampRepairs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(REPAIR_ATTEMPT_CEILING, Math.trunc(value)));
}

function dedupeLocales(locales: readonly LocaleCode[]): LocaleCode[] {
  const seen = new Set<string>();
  const out: LocaleCode[] = [];
  for (const locale of locales) {
    const trimmed = locale.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function newJobId(): string {
  const random =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2, 10);
  return `job_${random}`;
}
