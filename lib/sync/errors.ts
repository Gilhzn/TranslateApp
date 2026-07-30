/**
 * Typed failures for the sync seam.
 *
 * Two distinct families, deliberately kept apart:
 *
 *   - {@link SyncPlanError} — the plan could not be *built*. Always the
 *     developer's own configuration (a traversing path pattern, two locales
 *     colliding on one file name), so the message names the offending input.
 *   - {@link SyncError} — the plan could not be *pushed*. Every transport and
 *     GitHub failure lands here with a stable machine-readable `code`, so no
 *     caller ever has to pattern-match on a raw fetch rejection or an HTTP
 *     status number.
 */

export type SyncPlanErrorCode =
  | "invalid-path"
  | "path-traversal"
  | "duplicate-path"
  | "invalid-target"
  | "no-locales"
  | "invalid-timestamp"
  | "serialize-failed";

export class SyncPlanError extends Error {
  readonly code: SyncPlanErrorCode;
  /** The user-supplied value that caused the rejection, when there is one. */
  readonly input: string | null;

  constructor(
    code: SyncPlanErrorCode,
    message: string,
    options: { input?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "SyncPlanError";
    this.code = code;
    this.input = options.input ?? null;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export type SyncErrorCode =
  /** No token configured; nothing was sent. */
  | "not-configured"
  /** 401 — token missing, expired or revoked. */
  | "unauthorized"
  /** 403 — token lacks the scope, or the repo forbids the write. */
  | "forbidden"
  /** 404 — repo, branch or path does not exist (or the token cannot see it). */
  | "not-found"
  /** 409 / "already exists" — the remote moved under us. */
  | "conflict"
  /** 422 — GitHub rejected the payload. */
  | "validation-failed"
  /** 403/429 with rate-limit headers, or a secondary rate limit. */
  | "rate-limited"
  /** 5xx. */
  | "server-error"
  /** fetch itself rejected: DNS, TLS, offline. */
  | "network"
  /** The caller's AbortSignal fired. */
  | "aborted"
  /** 2xx with a body that is not the shape the API documents. */
  | "malformed-response"
  /** Anything else, so the union stays total. */
  | "unexpected";

export interface RateLimitSnapshot {
  /** Requests left in the current window; null when the header was absent. */
  remaining: number | null;
  /** Epoch milliseconds at which the window resets; null when unknown. */
  resetAt: number | null;
}

export interface SyncErrorInit {
  status?: number | null;
  /** Milliseconds to wait before retrying; null when the API gave no hint. */
  retryAfterMs?: number | null;
  rateLimit?: RateLimitSnapshot | null;
  /** GitHub's `x-github-request-id`, the only useful thing in a support ticket. */
  requestId?: string | null;
  documentationUrl?: string | null;
  /** Field-level complaints from a 422 body. */
  details?: string[];
  cause?: unknown;
}

/** Every failure the adapter surfaces. Raw fetch errors never escape. */
export class SyncError extends Error {
  readonly code: SyncErrorCode;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly rateLimit: RateLimitSnapshot | null;
  readonly requestId: string | null;
  readonly documentationUrl: string | null;
  readonly details: string[];

  constructor(code: SyncErrorCode, message: string, init: SyncErrorInit = {}) {
    super(message);
    this.name = "SyncError";
    this.code = code;
    this.status = init.status ?? null;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.rateLimit = init.rateLimit ?? null;
    this.requestId = init.requestId ?? null;
    this.documentationUrl = init.documentationUrl ?? null;
    this.details = init.details ?? [];
    if (init.cause !== undefined) this.cause = init.cause;
  }

  /** True when the same request, sent again later, could plausibly succeed. */
  get retryable(): boolean {
    return (
      this.code === "rate-limited" ||
      this.code === "server-error" ||
      this.code === "network"
    );
  }

  /** One line for a toast: what happened and what the developer can do. */
  get userMessage(): string {
    switch (this.code) {
      case "not-configured":
        return "Connect a GitHub token to push this plan.";
      case "unauthorized":
        return "GitHub rejected the token. Generate a new one with `repo` scope.";
      case "forbidden":
        return "The token cannot write to this repository. Check its scopes and repo access.";
      case "not-found":
        return "Repository, branch or path not found — or the token cannot see it.";
      case "conflict":
        return "The branch moved on GitHub. Refresh and re-plan before pushing.";
      case "validation-failed":
        return `GitHub rejected the request: ${this.details[0] ?? this.message}`;
      case "rate-limited":
        return this.retryAfterMs !== null
          ? `GitHub rate limit hit. Retry in ${Math.ceil(this.retryAfterMs / 1000)}s.`
          : "GitHub rate limit hit. Retry shortly.";
      case "server-error":
        return "GitHub is having trouble. Retry in a moment.";
      case "network":
        return "Could not reach GitHub. Check the connection and retry.";
      case "aborted":
        return "Push cancelled.";
      case "malformed-response":
        return "GitHub returned an unexpected response; nothing further was pushed.";
      default:
        return this.message;
    }
  }
}

/** Wrap an unknown thrown value as a {@link SyncError} without losing it. */
export function toSyncError(cause: unknown, fallback: string): SyncError {
  if (cause instanceof SyncError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new SyncError("unexpected", `${fallback}: ${message}`, { cause });
}
