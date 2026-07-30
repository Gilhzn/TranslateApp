/**
 * Pipeline-level failures.
 *
 * Three kinds, and the distinction is load-bearing:
 *
 *   - {@link JobAbortedError} — the caller (or a disconnected browser) asked us
 *     to stop. Not a defect; nothing is emitted.
 *   - {@link StructuralIntegrityError} — the rebuilt tree diverged from the
 *     source tree. This is the one failure the whole product exists to prevent,
 *     so it is a hard, job-level error rather than a per-entry issue: a corrupt
 *     catalogue must never reach the developer's repository.
 *   - {@link PipelineRequestError} — the HTTP request was malformed. Carries an
 *     HTTP status and a machine-readable code so the route can answer with a
 *     typed body instead of a stack trace.
 */

import { LingoLoopError } from "@/lib/validate";
import type { Issue, IssueSeverity, LocaleCode } from "@/lib/types";

/** Raised when an {@link AbortSignal} fires while a job is in flight. */
export class JobAbortedError extends Error {
  constructor(message = "The translation job was cancelled before it finished.") {
    super(message);
    this.name = "JobAbortedError";
  }
}

export function isJobAborted(value: unknown): value is JobAbortedError {
  return value instanceof JobAbortedError;
}

/** True when `signal` exists and has already fired. */
export function isAborted(signal: AbortSignal | undefined): boolean {
  // Written as a function because an inline `signal?.aborted === true` is
  // narrowed to `false` by the compiler for the rest of the enclosing block.
  return signal !== undefined && signal.aborted;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (isAborted(signal)) throw new JobAbortedError();
}

/**
 * The rebuilt tree is not structurally identical to the source tree.
 *
 * Carries every divergence the parity check found (capped by the checker) so
 * the UI can name the exact paths rather than saying "something went wrong".
 */
export class StructuralIntegrityError extends LingoLoopError {
  readonly locale: LocaleCode;
  readonly issues: readonly Issue[];

  constructor(locale: LocaleCode, issues: readonly Issue[]) {
    const first = issues[0];
    super(
      "structure-mismatch",
      `The rebuilt "${locale}" catalogue is not structurally identical to the source: ` +
        `${issues.length} divergence(s)${first !== undefined ? `, first at ${String(first.detail?.["path"] ?? first.key ?? "(root)")}` : ""}. ` +
        `Nothing was emitted for this locale — shipping a structurally different file would break the developer's app at runtime.`,
      { detail: { locale, divergences: issues.length } },
    );
    this.name = "StructuralIntegrityError";
    this.locale = locale;
    this.issues = issues;
  }
}

export type RequestErrorCode =
  | "invalid-json"
  | "invalid-body"
  | "payload-too-large"
  | "unsupported-media-type"
  | "source-parse-failed";

export interface RequestErrorBody {
  error: {
    code: RequestErrorCode;
    message: string;
    /** Dotted path of the offending field, when one can be named. */
    field?: string;
    detail?: Record<string, string | number | boolean | null>;
  };
}

export interface PipelineRequestErrorOptions {
  field?: string;
  detail?: Record<string, string | number | boolean | null>;
  severity?: IssueSeverity;
}

/**
 * A rejected HTTP request.
 *
 * Every message here is written to be shown to a developer verbatim: it says
 * which field was wrong and what would have been accepted. None of them ever
 * echo the whole payload back, which is how a "helpful" error message becomes
 * a reflected-content vector.
 */
export class PipelineRequestError extends Error {
  readonly status: number;
  readonly code: RequestErrorCode;
  readonly field: string | undefined;
  readonly detail: Record<string, string | number | boolean | null> | undefined;

  constructor(
    status: number,
    code: RequestErrorCode,
    message: string,
    options: PipelineRequestErrorOptions = {},
  ) {
    super(message);
    this.name = "PipelineRequestError";
    this.status = status;
    this.code = code;
    this.field = options.field;
    this.detail = options.detail;
  }

  toBody(): RequestErrorBody {
    const error: RequestErrorBody["error"] = {
      code: this.code,
      message: this.message,
    };
    if (this.field !== undefined) error.field = this.field;
    if (this.detail !== undefined) error.detail = this.detail;
    return { error };
  }
}

export function isPipelineRequestError(
  value: unknown,
): value is PipelineRequestError {
  return value instanceof PipelineRequestError;
}
