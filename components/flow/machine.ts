/**
 * The end-to-end flow's state machine.
 *
 * Pure and React-free on purpose: the flow has five phases, four ways to fail
 * and a partial-results path out of two of them, and none of that is
 * expressible as a handful of booleans without producing states the UI cannot
 * render (running *and* complete, error *and* idle, results with no request).
 * A tagged union makes every reachable state nameable, and this file is where
 * the transitions are decided and tested — `TranslationFlow.tsx` only performs
 * I/O and renders whatever comes back out.
 *
 * The wire decoders live here too. Everything arriving over SSE is `unknown`
 * until proven otherwise, including from our own route: a proxy that truncates
 * a frame, a deploy skew between client and server, or a `data:` line that
 * failed to re-join must degrade to a typed refusal rather than a `TypeError`
 * thrown out of a render.
 */

import type { ParsedCatalog } from "@/lib/core";
import type { ActiveProviderDescription } from "@/lib/engine";
import type {
  Issue,
  JobPhase,
  JobProgress,
  LocaleCode,
  LocaleResult,
  TranslationSettings,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Wire events
// ---------------------------------------------------------------------------

/** Payload of the route's `start` event. */
export interface JobStartEvent {
  fileName: string;
  sourceLocale: LocaleCode;
  targetLocales: readonly LocaleCode[];
  totalUnits: number;
  translatableKeys: number;
  provider: ActiveProviderDescription | null;
}

/** Payload of the route's `done` event. */
export interface JobDoneEvent {
  jobId: string;
  durationMs: number;
  issues: readonly Issue[];
}

/** Payload of the route's `error` event. */
export interface JobErrorEvent {
  code: string;
  message: string;
  paths: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function decodeJobStart(data: unknown): JobStartEvent | null {
  if (!isRecord(data)) return null;
  const provider = data["provider"];
  return {
    fileName: str(data["fileName"], "source.json"),
    sourceLocale: str(data["sourceLocale"], "en"),
    targetLocales: strList(data["targetLocales"]),
    totalUnits: num(data["totalUnits"], 0),
    translatableKeys: num(data["translatableKeys"], 0),
    // Trusted only for display, and only when it has the two fields the pill
    // reads; a half-decoded provider is worse than none.
    provider:
      isRecord(provider) && typeof provider["headline"] === "string"
        ? (provider as unknown as ActiveProviderDescription)
        : null,
  };
}

const PHASES: ReadonlySet<string> = new Set<JobPhase>([
  "queued",
  "parsing",
  "analyzing",
  "translating",
  "validating",
  "repairing",
  "complete",
  "error",
]);

export function decodeProgress(data: unknown): JobProgress | null {
  if (!isRecord(data)) return null;
  const phase = data["phase"];
  if (typeof phase !== "string" || !PHASES.has(phase)) return null;
  const locale = data["locale"];
  return {
    phase: phase as JobPhase,
    progress: Math.min(1, Math.max(0, num(data["progress"], 0))),
    locale: typeof locale === "string" ? locale : null,
    completedUnits: num(data["completedUnits"], 0),
    totalUnits: num(data["totalUnits"], 0),
    message: str(data["message"], ""),
  };
}

/**
 * A `locale-complete` payload is only accepted when it carries the three things
 * the review surface cannot be built without: a locale, an entry list and a
 * rebuilt tree. Anything else is dropped, and a job whose locales all drop ends
 * as "finished but produced nothing" rather than as an empty review table.
 */
export function decodeLocaleResult(data: unknown): LocaleResult | null {
  if (!isRecord(data)) return null;
  if (typeof data["locale"] !== "string") return null;
  if (!Array.isArray(data["entries"])) return null;
  if (!("tree" in data)) return null;
  if (!isRecord(data["stats"])) return null;
  return data as unknown as LocaleResult;
}

export function decodeJobDone(data: unknown): JobDoneEvent {
  if (!isRecord(data)) return { jobId: "", durationMs: 0, issues: [] };
  const issues = data["issues"];
  return {
    jobId: str(data["jobId"], ""),
    durationMs: num(data["durationMs"], 0),
    issues: Array.isArray(issues) ? (issues as Issue[]) : [],
  };
}

export function decodeJobError(data: unknown): JobErrorEvent {
  if (!isRecord(data)) {
    return {
      code: "job-failed",
      message: "The job reported a failure with no detail.",
      paths: [],
    };
  }
  return {
    code: str(data["code"], "job-failed"),
    message: str(data["message"], "The job reported a failure with no detail."),
    paths: strList(data["paths"]),
  };
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * Why a run stopped. The kind decides which recovery controls are offered, so
 * it is coarse on purpose — four kinds, each with a different remedy.
 */
export type FlowFailureKind =
  | "request" // the server refused before the stream began
  | "job" // the job itself failed mid-stream
  | "network" // the connection died; nothing was refused
  | "cancelled"; // the developer stopped it

export interface FlowFailure {
  kind: FlowFailureKind;
  /** Machine-readable code, from the server where there was one. */
  code: string;
  /** One short line, in the imperative or the past tense. Never "Oops". */
  title: string;
  /** The server's own words, or the transport's. */
  message: string;
  /** Supporting lines — offending field, diverging key paths. */
  detail: readonly string[];
  /** What to do next, in the developer's terms. */
  hint: string;
  /** True when re-sending the identical request could plausibly succeed. */
  retryable: boolean;
}

const REQUEST_HINTS: Readonly<Record<string, string>> = {
  "payload-too-large":
    "Split the catalogue, or translate fewer locales per run — each locale multiplies the work but not the upload.",
  "source-parse-failed":
    "Fix the JSON at the position above and drop the file again.",
  "invalid-body": "Adjust the highlighted setting and start the run again.",
  "invalid-json": "The request body did not survive the trip. Start the run again.",
  "unsupported-media-type":
    "The request was not sent as JSON. Reload the page and try again.",
};

/** Build a failure from a non-2xx response to the POST. */
export function failureFromResponse(status: number, body: unknown): FlowFailure {
  const error = isRecord(body) ? body["error"] : undefined;
  const code = isRecord(error) ? str(error["code"], "request-rejected") : "request-rejected";
  const message = isRecord(error)
    ? str(error["message"], `The server answered ${status} with no explanation.`)
    : `The server answered ${status} with no explanation.`;

  const detail: string[] = [];
  if (isRecord(error) && typeof error["field"] === "string") {
    detail.push(`Field: ${error["field"]}`);
  }
  if (isRecord(error) && isRecord(error["detail"])) {
    for (const [key, value] of Object.entries(error["detail"])) {
      if (value === null || typeof value === "object") continue;
      detail.push(`${key}: ${String(value)}`);
    }
  }

  return {
    kind: "request",
    code,
    title: `The run was refused (HTTP ${status})`,
    message,
    detail,
    hint:
      REQUEST_HINTS[code] ??
      (status >= 500
        ? "That is a server-side fault, not a problem with your catalogue. Try again."
        : "Adjust the request and start the run again."),
    // A 4xx means the same bytes will be refused the same way; a 5xx might not.
    retryable: status >= 500,
  };
}

/** Build a failure from an `error` event that arrived mid-stream. */
export function failureFromJobEvent(event: JobErrorEvent): FlowFailure {
  if (event.code === "cancelled") return cancelledFailure();

  if (event.code === "structure-mismatch") {
    return {
      kind: "job",
      code: event.code,
      title: "Output structure diverged from the source",
      message: event.message,
      detail: event.paths.map((path) => `Diverging key: ${path}`),
      hint: "Nothing was written. This is a guarantee the export refuses to break, so the run was stopped rather than shipped — re-run to retry the locale.",
      retryable: true,
    };
  }

  return {
    kind: "job",
    code: event.code,
    title: "The translation job failed",
    message: event.message,
    detail: event.paths.map((path) => `Key: ${path}`),
    hint: "Locales that finished before the failure are still complete and can be reviewed and exported.",
    retryable: true,
  };
}

/** Build a failure from a thrown fetch/stream error that was not an abort. */
export function failureFromTransport(error: unknown): FlowFailure {
  const message =
    error instanceof Error ? error.message : "The connection failed for an unknown reason.";
  return {
    kind: "network",
    code: "network",
    title: "The connection to the job dropped",
    message,
    detail: [],
    hint: "The job stops on the server as soon as the stream closes, so nothing is running in the background. Re-run when the connection is back.",
    retryable: true,
  };
}

export function cancelledFailure(): FlowFailure {
  return {
    kind: "cancelled",
    code: "cancelled",
    title: "Run cancelled",
    message: "The stream was closed, which stops the job on the server within one batch.",
    detail: [],
    hint: "Nothing was written to disk. Locales that had already finished are kept.",
    retryable: true,
  };
}

/** The stream ended without a terminal `done` or `error` frame. */
export function truncatedFailure(): FlowFailure {
  return {
    kind: "network",
    code: "stream-truncated",
    title: "The stream ended mid-job",
    message:
      "The server closed the event stream without sending a completion or an error frame.",
    detail: [],
    hint: "A proxy timeout is the usual cause. Any locale that completed before the cut is kept.",
    retryable: true,
  };
}

export function emptyResultFailure(): FlowFailure {
  return {
    kind: "job",
    code: "no-results",
    title: "The job finished without producing a locale",
    message:
      "Every locale either failed to decode or was dropped, so there is nothing to review.",
    detail: [],
    hint: "Re-run the job. If it repeats, the source file is the place to look.",
    retryable: true,
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type FlowPhase = "idle" | "configuring" | "running" | "complete" | "error";

/** Everything needed to (re-)dispatch a run, and to render the review after. */
export interface RunRequest {
  catalog: ParsedCatalog;
  settings: TranslationSettings;
  /**
   * The file's own bytes, forwarded verbatim. The route parses the source
   * itself, and it has to parse *the developer's* file rather than a client-side
   * reconstruction of it — otherwise "structurally identical to the input" is
   * measured against the wrong input.
   */
  sourceText: string;
}

export interface RunState {
  request: RunRequest;
  startedAt: number;
  start: JobStartEvent | null;
  progress: JobProgress | null;
  results: readonly LocaleResult[];
  /** Locales the server has reported progress for; used for "in flight". */
  touched: readonly LocaleCode[];
}

export type FlowState =
  | { phase: "idle" }
  | { phase: "configuring"; catalog: ParsedCatalog }
  | { phase: "running"; run: RunState }
  | { phase: "complete"; run: RunState; done: JobDoneEvent | null; finishedAt: number }
  | { phase: "error"; run: RunState; failure: FlowFailure };

export type FlowAction =
  | { type: "catalog-loaded"; catalog: ParsedCatalog | null }
  | { type: "run-requested"; request: RunRequest; at: number }
  | { type: "job-started"; event: JobStartEvent }
  | { type: "progress"; progress: JobProgress }
  | { type: "locale-complete"; result: LocaleResult }
  | { type: "job-done"; event: JobDoneEvent; at: number }
  | { type: "job-failed"; failure: FlowFailure }
  | { type: "review-partial"; at: number }
  | { type: "back-to-setup" }
  | { type: "reset" };

export const INITIAL_FLOW_STATE: FlowState = { phase: "idle" };

/** The run a state is carrying, if it is carrying one. */
export function runOf(state: FlowState): RunState | null {
  switch (state.phase) {
    case "running":
    case "complete":
    case "error":
      return state.run;
    default:
      return null;
  }
}

function withTouched(run: RunState, locale: LocaleCode | null): readonly LocaleCode[] {
  if (locale === null || run.touched.includes(locale)) return run.touched;
  return [...run.touched, locale];
}

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case "catalog-loaded":
      // Only meaningful while the developer is at the form; a late parse must
      // never yank a running job or a finished review off the screen.
      if (state.phase !== "idle" && state.phase !== "configuring") return state;
      return action.catalog === null
        ? { phase: "idle" }
        : { phase: "configuring", catalog: action.catalog };

    case "run-requested":
      return {
        phase: "running",
        run: {
          request: action.request,
          startedAt: action.at,
          start: null,
          progress: null,
          results: [],
          touched: [],
        },
      };

    case "job-started":
      if (state.phase !== "running") return state;
      return { ...state, run: { ...state.run, start: action.event } };

    case "progress": {
      if (state.phase !== "running") return state;
      return {
        ...state,
        run: {
          ...state.run,
          progress: action.progress,
          touched: withTouched(state.run, action.progress.locale),
        },
      };
    }

    case "locale-complete": {
      if (state.phase !== "running") return state;
      // A locale is announced exactly once, but a retried frame must not
      // duplicate a column in the review table.
      if (state.run.results.some((result) => result.locale === action.result.locale)) {
        return state;
      }
      return {
        ...state,
        run: {
          ...state.run,
          results: [...state.run.results, action.result],
          touched: withTouched(state.run, action.result.locale),
        },
      };
    }

    case "job-done": {
      if (state.phase !== "running") return state;
      if (state.run.results.length === 0) {
        return { phase: "error", run: state.run, failure: emptyResultFailure() };
      }
      return {
        phase: "complete",
        run: state.run,
        done: action.event,
        finishedAt: action.at,
      };
    }

    case "job-failed":
      if (state.phase !== "running") return state;
      return { phase: "error", run: state.run, failure: action.failure };

    case "review-partial":
      // Offered only when a failed or cancelled run left finished locales
      // behind: those files are complete and exporting them is not a
      // consolation prize.
      if (state.phase !== "error" || state.run.results.length === 0) return state;
      return { phase: "complete", run: state.run, done: null, finishedAt: action.at };

    case "back-to-setup": {
      const run = runOf(state);
      if (run === null) return state;
      return { phase: "configuring", catalog: run.request.catalog };
    }

    case "reset":
      return INITIAL_FLOW_STATE;

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

export type LocaleRunState = "queued" | "active" | "done";

export interface LocaleTrack {
  locale: LocaleCode;
  state: LocaleRunState;
  result: LocaleResult | null;
}

/**
 * One row per target locale, in the order the developer picked them.
 *
 * Locales run concurrently, so "active" is every locale the server has spoken
 * about that has not yet completed — not a single cursor.
 */
export function localeTracks(run: RunState): LocaleTrack[] {
  const done = new Map<LocaleCode, LocaleResult>();
  for (const result of run.results) done.set(result.locale, result);

  const targets =
    run.start !== null && run.start.targetLocales.length > 0
      ? run.start.targetLocales
      : run.request.settings.targetLocales;

  return targets.map((locale) => {
    const result = done.get(locale) ?? null;
    const state: LocaleRunState =
      result !== null ? "done" : run.touched.includes(locale) ? "active" : "queued";
    return { locale, state, result };
  });
}

export const PHASE_LABEL: Readonly<Record<JobPhase, string>> = {
  queued: "Queued",
  parsing: "Parsing",
  analyzing: "Analysing",
  translating: "Translating",
  validating: "Validating",
  repairing: "Repairing overflow",
  complete: "Complete",
  error: "Failed",
};

/** Totals across the locales that finished, for the completion summary. */
export interface RunTotals {
  strings: number;
  passed: number;
  flagged: number;
  failed: number;
  overflowRepaired: number;
}

export function runTotals(results: readonly LocaleResult[]): RunTotals {
  const totals: RunTotals = {
    strings: 0,
    passed: 0,
    flagged: 0,
    failed: 0,
    overflowRepaired: 0,
  };
  for (const result of results) {
    totals.strings += result.stats.total;
    totals.passed += result.stats.passed;
    totals.flagged += result.stats.flagged;
    totals.failed += result.stats.failed;
    totals.overflowRepaired += result.stats.overflowRepaired;
  }
  return totals;
}

/** "1m 04s" / "12.4s" / "840ms" — monospace-friendly and never "a few seconds". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}
