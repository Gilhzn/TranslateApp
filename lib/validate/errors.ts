import type { Issue, IssueCode, IssueSeverity } from "@/lib/types";

/**
 * Error taxonomy.
 *
 * Two representations of the same fact coexist in this pipeline:
 *
 *   - `Issue` — data. Accumulated per entry, serialised to the UI, never thrown.
 *   - `LingoLoopError` — control flow. Thrown when a step cannot continue.
 *
 * They share the `IssueCode` vocabulary so a thrown failure can always be
 * downgraded into a reportable issue (`err.toIssue()`) without inventing a new
 * classification at the catch site. That is the whole point of the base class:
 * every catch block in the app can produce a well-formed `Issue` instead of a
 * bare `String(err)`.
 */

export type IssueDetail = Record<string, string | number | boolean | null>;

export interface IssueOptions {
  /** Entry key this issue belongs to; omit for file-level issues. */
  key?: string;
  detail?: IssueDetail;
}

/**
 * Total order on severity. Exposed because "the single most severe" is asked
 * for in three different places (entry status, locale rollup, job rollup) and
 * they must all agree.
 */
export const SEVERITY_RANK: Readonly<Record<IssueSeverity, number>> =
  Object.freeze({
    info: 0,
    warning: 1,
    error: 2,
  });

/**
 * Default severity for every code in the contract.
 *
 * The table is typed as a *total* `Record<IssueCode, …>`, so adding a code to
 * `lib/types.ts` without classifying it here is a compile error, and
 * `policy.test.ts` re-derives the union from the contract source so it is also
 * a test failure.
 *
 * Rationale for the non-obvious rows:
 *   - `placeholder-reordered` is INFO because reordering is how grammar works.
 *     Validators escalate it to ERROR only for positional printf, where order
 *     is the argument binding (see `validatePlaceholderParity`).
 *   - `control-characters` defaults to ERROR: a raw C0 byte in a shipped JSON
 *     catalogue is corruption, not style. Validators downgrade the zero-width
 *     subset to WARNING because those are mechanically strippable.
 *   - `length-tight` is WARNING, not ERROR: it is inside the grace band, so it
 *     renders — spending another model call on it is not worth the latency.
 *   - `budget-exhausted` is WARNING: it describes the *process* giving up, and
 *     the underlying linguistic problem is already reported by its own code.
 */
export const SEVERITY_POLICY: Readonly<Record<IssueCode, IssueSeverity>> =
  Object.freeze({
    "placeholder-missing": "error",
    "placeholder-added": "error",
    "placeholder-malformed": "error",
    "placeholder-reordered": "info",
    "length-overflow": "error",
    "length-tight": "warning",
    "empty-translation": "error",
    untranslated: "warning",
    "structure-mismatch": "error",
    "invalid-json": "error",
    "control-characters": "error",
    "tag-imbalance": "error",
    "whitespace-drift": "warning",
    "casing-drift": "info",
    "provider-error": "error",
    "budget-exhausted": "warning",
  });

/** Every classified code, derived from the policy table so the two cannot drift. */
export const ALL_ISSUE_CODES: readonly IssueCode[] = Object.freeze(
  Object.keys(SEVERITY_POLICY) as IssueCode[],
);

/** Codes that describe a broken interpolation contract. */
export const PLACEHOLDER_CODES: readonly IssueCode[] = Object.freeze([
  "placeholder-missing",
  "placeholder-added",
  "placeholder-malformed",
  "placeholder-reordered",
]);

export function defaultSeverity(code: IssueCode): IssueSeverity {
  return SEVERITY_POLICY[code];
}

/**
 * Construct an `Issue`. Optional fields are omitted rather than set to
 * `undefined` so that structural equality in tests and `JSON.stringify` on the
 * wire both behave predictably.
 */
export function issue(
  code: IssueCode,
  severity: IssueSeverity,
  message: string,
  opts: IssueOptions = {},
): Issue {
  const out: Issue = { code, severity, message };
  if (opts.key !== undefined) out.key = opts.key;
  if (opts.detail !== undefined) out.detail = opts.detail;
  return out;
}

/** `issue()` with the severity taken from {@link SEVERITY_POLICY}. */
export function classify(
  code: IssueCode,
  message: string,
  opts: IssueOptions = {},
): Issue {
  return issue(code, defaultSeverity(code), message, opts);
}

export function compareSeverity(a: IssueSeverity, b: IssueSeverity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b];
}

export function isBlocking(candidate: Issue): boolean {
  return candidate.severity === "error";
}

export interface IssueSummary {
  total: number;
  errors: number;
  warnings: number;
  infos: number;
  /** Occurrence count per code; codes that never fired are absent. */
  byCode: Partial<Record<IssueCode, number>>;
  /** Highest severity present, or `null` for an empty list. */
  mostSevere: IssueSeverity | null;
  /** First issue at `mostSevere` — the headline the review table shows. */
  headline: Issue | null;
}

/**
 * Reduce a list of issues to counts plus the single most severe.
 *
 * "First at the highest severity" is deliberate: validators run in a fixed
 * order (parity, emptiness, then cosmetics), so the headline is the most
 * structurally important failure rather than whichever one sorted first
 * alphabetically.
 */
export function summarizeIssues(issues: readonly Issue[]): IssueSummary {
  const byCode: Partial<Record<IssueCode, number>> = {};
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  let headline: Issue | null = null;

  for (const item of issues) {
    byCode[item.code] = (byCode[item.code] ?? 0) + 1;
    if (item.severity === "error") errors += 1;
    else if (item.severity === "warning") warnings += 1;
    else infos += 1;

    if (headline === null || compareSeverity(item.severity, headline.severity) > 0) {
      headline = item;
    }
  }

  return {
    total: issues.length,
    errors,
    warnings,
    infos,
    byCode,
    mostSevere: headline === null ? null : headline.severity,
    headline,
  };
}

/** Highest severity in a list, or `null` when empty. */
export function maxSeverity(issues: readonly Issue[]): IssueSeverity | null {
  return summarizeIssues(issues).mostSevere;
}

// ---------------------------------------------------------------------------
// Throwables
// ---------------------------------------------------------------------------

export interface LingoLoopErrorOptions extends IssueOptions {
  /** Overrides the policy default — rare; used for soft provider failures. */
  severity?: IssueSeverity;
  cause?: unknown;
}

export class LingoLoopError extends Error {
  readonly code: IssueCode;
  readonly severity: IssueSeverity;
  readonly key: string | undefined;
  readonly detail: IssueDetail | undefined;

  constructor(
    code: IssueCode,
    message: string,
    options: LingoLoopErrorOptions = {},
  ) {
    super(
      message,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "LingoLoopError";
    this.code = code;
    this.severity = options.severity ?? defaultSeverity(code);
    this.key = options.key;
    this.detail = options.detail;
  }

  toIssue(): Issue {
    const opts: IssueOptions = {};
    if (this.key !== undefined) opts.key = this.key;
    if (this.detail !== undefined) opts.detail = this.detail;
    return issue(this.code, this.severity, this.message, opts);
  }
}

/** The uploaded file could not be read as a locale catalogue. */
export class SourceParseError extends LingoLoopError {
  constructor(message: string, options: LingoLoopErrorOptions = {}) {
    super("invalid-json", message, options);
    this.name = "SourceParseError";
  }
}

/** A translation provider failed, refused, or returned an unusable payload. */
export class ProviderError extends LingoLoopError {
  /** True when a retry with identical input could plausibly succeed. */
  readonly retryable: boolean;

  constructor(
    message: string,
    options: LingoLoopErrorOptions & { retryable?: boolean } = {},
  ) {
    super("provider-error", message, options);
    this.name = "ProviderError";
    this.retryable = options.retryable ?? false;
  }
}

/** A per-string validation rule failed hard enough to abort its caller. */
export class ValidationError extends LingoLoopError {
  constructor(
    code: IssueCode,
    message: string,
    options: LingoLoopErrorOptions = {},
  ) {
    super(code, message, options);
    this.name = "ValidationError";
  }
}

/** The rebuilt tree diverged from the source tree. */
export class StructureError extends LingoLoopError {
  /** Encoded path of the divergence, e.g. `menu.file[0]`. */
  readonly path: string;

  constructor(
    path: string,
    message: string,
    options: LingoLoopErrorOptions = {},
  ) {
    super("structure-mismatch", message, {
      ...options,
      detail: { path, ...(options.detail ?? {}) },
    });
    this.name = "StructureError";
    this.path = path;
  }
}

export function isLingoLoopError(value: unknown): value is LingoLoopError {
  return value instanceof LingoLoopError;
}

/**
 * Convert anything a `catch` block can receive into an `Issue`.
 *
 * Providers throw `AbortError`, `TypeError: fetch failed`, SDK error objects
 * and occasionally plain strings. The pipeline must never surface `[object
 * Object]` to a developer, so this normalises all of it.
 */
export function toIssue(
  value: unknown,
  fallbackCode: IssueCode = "provider-error",
  opts: IssueOptions = {},
): Issue {
  if (isLingoLoopError(value)) {
    const merged: IssueOptions = {};
    const key = opts.key ?? value.key;
    if (key !== undefined) merged.key = key;
    const detail =
      value.detail !== undefined || opts.detail !== undefined
        ? { ...(value.detail ?? {}), ...(opts.detail ?? {}) }
        : undefined;
    if (detail !== undefined) merged.detail = detail;
    return issue(value.code, value.severity, value.message, merged);
  }
  if (value instanceof Error) {
    const detail: IssueDetail = { ...(opts.detail ?? {}), errorName: value.name };
    return classify(fallbackCode, value.message || value.name, {
      ...opts,
      detail,
    });
  }
  return classify(fallbackCode, describeUnknown(value), opts);
}

function describeUnknown(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (value === null) return "Unknown failure (null)";
  if (value === undefined) return "Unknown failure (undefined)";
  try {
    return `Unknown failure: ${JSON.stringify(value)}`;
  } catch {
    return `Unknown failure: ${String(value)}`;
  }
}
