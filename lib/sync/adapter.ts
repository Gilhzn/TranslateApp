/**
 * The push seam.
 *
 * {@link SyncAdapter} is the whole contract between LingoLoop and a git host:
 * make a branch, write a file, open a pull request. The MVP ships without a
 * token and therefore never calls it — but the implementation below is real,
 * so turning sync on is a matter of supplying a token, not writing code.
 *
 * Two rules hold everywhere in this file:
 *
 *   1. No raw failure escapes. `fetch` rejections, HTML error pages, 403s that
 *      are really rate limits — all of it arrives at the caller as a
 *      {@link SyncError} with a stable `code`.
 *   2. Every request honours an `AbortSignal`, including one that is already
 *      aborted before the call.
 */

import { SyncError, type RateLimitSnapshot } from "./errors";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface CreateBranchInput extends RepoRef {
  /** Branch to fork from, e.g. `main`. */
  baseBranch: string;
  /** Branch to create, e.g. `lingoloop/20260730-1432-de-8a41c0d2f3`. */
  branchName: string;
}

export interface BranchRef {
  name: string;
  /** Head commit the branch points at. */
  sha: string;
  /** False when the branch already existed and was reused. */
  created: boolean;
}

export interface PutFileInput extends RepoRef {
  branch: string;
  /** Repository-relative path, e.g. `public/locales/de.json`. */
  path: string;
  /** UTF-8 text; the adapter handles transport encoding. */
  contents: string;
  /** Commit message for this write. */
  message: string;
}

export interface CommitRef {
  /** Commit created by the write. */
  sha: string;
  /** Blob sha of the written file. */
  contentSha: string;
  /** Web URL of the commit, when the host provides one. */
  url: string | null;
  /** False when the file already had exactly these bytes. */
  changed: boolean;
}

export interface OpenPullRequestInput extends RepoRef {
  /** Branch holding the changes. */
  head: string;
  /** Branch to merge into. */
  base: string;
  title: string;
  body: string;
  draft?: boolean;
}

export interface PullRequestRef {
  number: number;
  url: string;
  state: string;
  draft: boolean;
}

/** What a git host must be able to do for LingoLoop to push to it. */
export interface SyncAdapter {
  readonly id: string;
  readonly label: string;
  /** False when credentials are missing; nothing should be attempted. */
  isConfigured(): boolean;
  createBranch(input: CreateBranchInput, signal?: AbortSignal): Promise<BranchRef>;
  putFile(input: PutFileInput, signal?: AbortSignal): Promise<CommitRef>;
  openPullRequest(
    input: OpenPullRequestInput,
    signal?: AbortSignal,
  ): Promise<PullRequestRef>;
}

// ---------------------------------------------------------------------------
// GitHub REST implementation
// ---------------------------------------------------------------------------

export type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface GitHubAdapterOptions {
  /** Personal access token or installation token. Empty means "not configured". */
  token?: string;
  /** Defaults to `https://api.github.com`; set for GitHub Enterprise. */
  baseUrl?: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Injected for tests; used only for rate-limit reset arithmetic. */
  now?: () => number;
  /** Sent as `User-Agent`; GitHub rejects requests without one. */
  userAgent?: string;
}

const DEFAULT_BASE_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";
const DEFAULT_USER_AGENT = "LingoLoop";

export class GitHubRestAdapter implements SyncAdapter {
  readonly id = "github";
  readonly label = "GitHub";

  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike | null;
  private readonly now: () => number;
  private readonly userAgent: string;

  constructor(options: GitHubAdapterOptions = {}) {
    this.token = (options.token ?? "").trim();
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? null;
    this.now = options.now ?? (() => Date.now());
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  isConfigured(): boolean {
    return this.token.length > 0;
  }

  async createBranch(
    input: CreateBranchInput,
    signal?: AbortSignal,
  ): Promise<BranchRef> {
    const { owner, repo } = input;
    const base = await this.request<GitRefResponse>(
      "GET",
      `/repos/${seg(owner)}/${seg(repo)}/git/ref/heads/${refPath(input.baseBranch)}`,
      null,
      signal,
    );
    const baseSha = base.object?.sha;
    if (typeof baseSha !== "string" || baseSha.length === 0) {
      throw new SyncError(
        "malformed-response",
        `GitHub returned no commit sha for ${input.baseBranch}.`,
      );
    }

    try {
      const created = await this.request<GitRefResponse>(
        "POST",
        `/repos/${seg(owner)}/${seg(repo)}/git/refs`,
        { ref: `refs/heads/${input.branchName}`, sha: baseSha },
        signal,
      );
      return {
        name: input.branchName,
        sha: created.object?.sha ?? baseSha,
        created: true,
      };
    } catch (error) {
      // A branch that already exists is the normal shape of "the developer
      // pushed this plan once already". Reuse it rather than failing the run;
      // the caller decides whether the existing head is acceptable.
      if (error instanceof SyncError && isAlreadyExists(error)) {
        const existing = await this.request<GitRefResponse>(
          "GET",
          `/repos/${seg(owner)}/${seg(repo)}/git/ref/heads/${refPath(input.branchName)}`,
          null,
          signal,
        );
        const sha = existing.object?.sha;
        if (typeof sha !== "string" || sha.length === 0) {
          throw new SyncError(
            "malformed-response",
            `GitHub returned no commit sha for the existing branch ${input.branchName}.`,
          );
        }
        return { name: input.branchName, sha, created: false };
      }
      throw error;
    }
  }

  async putFile(input: PutFileInput, signal?: AbortSignal): Promise<CommitRef> {
    const { owner, repo } = input;
    const contentPath = `/repos/${seg(owner)}/${seg(repo)}/contents/${refPath(input.path)}`;

    // Updating an existing file requires its current blob sha; omitting it on
    // an existing path is a 422, and sending a stale one is a 409.
    let existingSha: string | null = null;
    try {
      const existing = await this.request<ContentsResponse>(
        "GET",
        `${contentPath}?ref=${encodeURIComponent(input.branch)}`,
        null,
        signal,
      );
      if (typeof existing.sha === "string") existingSha = existing.sha;
    } catch (error) {
      if (!(error instanceof SyncError) || error.code !== "not-found") throw error;
    }

    const body: Record<string, string> = {
      message: input.message,
      content: encodeBase64(input.contents),
      branch: input.branch,
    };
    if (existingSha !== null) body["sha"] = existingSha;

    const written = await this.request<PutContentsResponse>(
      "PUT",
      contentPath,
      body,
      signal,
    );

    const commitSha = written.commit?.sha;
    const contentSha = written.content?.sha;
    if (typeof commitSha !== "string" || typeof contentSha !== "string") {
      throw new SyncError(
        "malformed-response",
        `GitHub accepted the write to ${input.path} but returned no commit sha.`,
      );
    }

    return {
      sha: commitSha,
      contentSha,
      url: typeof written.commit?.html_url === "string" ? written.commit.html_url : null,
      changed: contentSha !== existingSha,
    };
  }

  async openPullRequest(
    input: OpenPullRequestInput,
    signal?: AbortSignal,
  ): Promise<PullRequestRef> {
    const body: Record<string, string | boolean> = {
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
    };
    if (input.draft === true) body["draft"] = true;

    const pr = await this.request<PullRequestResponse>(
      "POST",
      `/repos/${seg(input.owner)}/${seg(input.repo)}/pulls`,
      body,
      signal,
    );

    if (typeof pr.number !== "number" || typeof pr.html_url !== "string") {
      throw new SyncError(
        "malformed-response",
        "GitHub accepted the pull request but returned no number or URL.",
      );
    }
    return {
      number: pr.number,
      url: pr.html_url,
      state: typeof pr.state === "string" ? pr.state : "open",
      draft: pr.draft === true,
    };
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.isConfigured()) {
      throw new SyncError(
        "not-configured",
        "No GitHub token configured; nothing was sent.",
      );
    }
    // Checked up front so an already-aborted signal never reaches the network.
    throwIfAborted(signal);

    const doFetch = this.fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== "function") {
      throw new SyncError(
        "unexpected",
        "No fetch implementation available in this runtime.",
      );
    }

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": this.userAgent,
    };
    const init: RequestInit = { method, headers };
    if (body !== null && body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    if (signal !== undefined) init.signal = signal;

    let response: Response;
    try {
      response = await doFetch(`${this.baseUrl}${path}`, init);
    } catch (cause) {
      if (isAbortError(cause, signal)) {
        throw new SyncError("aborted", "Request cancelled.", { cause });
      }
      throw new SyncError(
        "network",
        `Could not reach ${this.baseUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }

    const raw = await this.readBody(response, signal);

    if (!response.ok) {
      throw this.toError(response, raw, method, path);
    }

    if (raw.trim().length === 0) return {} as T;
    try {
      return JSON.parse(raw) as T;
    } catch (cause) {
      throw new SyncError(
        "malformed-response",
        `${method} ${path} returned ${response.status} with a body that is not JSON.`,
        { status: response.status, cause },
      );
    }
  }

  private async readBody(
    response: Response,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    try {
      return await response.text();
    } catch (cause) {
      if (isAbortError(cause, signal)) {
        throw new SyncError("aborted", "Request cancelled.", { cause });
      }
      throw new SyncError(
        "network",
        "The connection dropped while reading GitHub's response.",
        { cause },
      );
    }
  }

  private toError(
    response: Response,
    raw: string,
    method: string,
    path: string,
  ): SyncError {
    const parsed = parseErrorBody(raw);
    const rateLimit = readRateLimit(response);
    const retryAfterMs = readRetryAfter(response, rateLimit, this.now());
    const where = `${method} ${path}`;
    const init = {
      status: response.status,
      rateLimit,
      retryAfterMs,
      requestId: response.headers.get("x-github-request-id"),
      documentationUrl: parsed.documentationUrl,
      details: parsed.details,
    };
    const detail = parsed.message ?? response.statusText ?? "no detail";

    // A 403 is GitHub's answer both to "wrong scope" and to "too many
    // requests"; only the headers tell them apart.
    if (response.status === 429 || (response.status === 403 && isRateLimited(response, parsed.message))) {
      return new SyncError(
        "rate-limited",
        `GitHub rate limit reached on ${where}: ${detail}`,
        init,
      );
    }

    switch (response.status) {
      case 401:
        return new SyncError(
          "unauthorized",
          `GitHub rejected the token on ${where}: ${detail}`,
          init,
        );
      case 403:
        return new SyncError(
          "forbidden",
          `GitHub refused ${where}: ${detail}`,
          init,
        );
      case 404:
        return new SyncError(
          "not-found",
          `GitHub could not find the target of ${where}. Either it does not exist or the token cannot see it.`,
          init,
        );
      case 409:
        return new SyncError(
          "conflict",
          `GitHub reported a conflict on ${where}: ${detail}`,
          init,
        );
      case 422:
        return new SyncError(
          "validation-failed",
          `GitHub rejected ${where}: ${detail}`,
          init,
        );
      default:
        break;
    }

    if (response.status >= 500) {
      return new SyncError(
        "server-error",
        `GitHub returned ${response.status} on ${where}: ${detail}`,
        init,
      );
    }
    return new SyncError(
      "unexpected",
      `GitHub returned ${response.status} on ${where}: ${detail}`,
      init,
    );
  }
}

// ---------------------------------------------------------------------------
// Response shapes (only the fields that are read)
// ---------------------------------------------------------------------------

interface GitRefResponse {
  ref?: string;
  object?: { sha?: string };
}

interface ContentsResponse {
  sha?: string;
  path?: string;
}

interface PutContentsResponse {
  content?: { sha?: string; path?: string };
  commit?: { sha?: string; html_url?: string };
}

interface PullRequestResponse {
  number?: number;
  html_url?: string;
  state?: string;
  draft?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ParsedErrorBody {
  message: string | null;
  details: string[];
  documentationUrl: string | null;
}

function parseErrorBody(raw: string): ParsedErrorBody {
  const empty: ParsedErrorBody = {
    message: null,
    details: [],
    documentationUrl: null,
  };
  if (raw.trim().length === 0) return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // GitHub Enterprise behind a proxy can answer with an HTML error page.
    const text = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return { ...empty, message: text.length > 0 ? text.slice(0, 200) : null };
  }
  if (parsed === null || typeof parsed !== "object") return empty;

  const record = parsed as Record<string, unknown>;
  const message = typeof record["message"] === "string" ? record["message"] : null;
  const documentationUrl =
    typeof record["documentation_url"] === "string"
      ? record["documentation_url"]
      : null;

  const details: string[] = [];
  const errors = record["errors"];
  if (Array.isArray(errors)) {
    for (const item of errors) {
      if (typeof item === "string") {
        details.push(item);
        continue;
      }
      if (item === null || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const field = typeof entry["field"] === "string" ? entry["field"] : null;
      const code = typeof entry["code"] === "string" ? entry["code"] : null;
      const detailMessage =
        typeof entry["message"] === "string" ? entry["message"] : null;
      const rendered = detailMessage ?? [field, code].filter(Boolean).join(": ");
      if (rendered.length > 0) details.push(rendered);
    }
  }

  return { message, details, documentationUrl };
}

function readRateLimit(response: Response): RateLimitSnapshot | null {
  const remainingRaw = response.headers.get("x-ratelimit-remaining");
  const resetRaw = response.headers.get("x-ratelimit-reset");
  if (remainingRaw === null && resetRaw === null) return null;

  const remaining = remainingRaw === null ? null : Number.parseInt(remainingRaw, 10);
  const reset = resetRaw === null ? null : Number.parseInt(resetRaw, 10);
  return {
    remaining: remaining !== null && Number.isFinite(remaining) ? remaining : null,
    // GitHub reports the reset as epoch *seconds*.
    resetAt: reset !== null && Number.isFinite(reset) ? reset * 1000 : null,
  };
}

function readRetryAfter(
  response: Response,
  rateLimit: RateLimitSnapshot | null,
  now: number,
): number | null {
  const header = response.headers.get("retry-after");
  if (header !== null) {
    const seconds = Number.parseInt(header, 10);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  if (rateLimit?.resetAt != null && rateLimit.remaining === 0) {
    return Math.max(0, rateLimit.resetAt - now);
  }
  return null;
}

function isRateLimited(response: Response, message: string | null): boolean {
  if (response.headers.get("retry-after") !== null) return true;
  const remaining = response.headers.get("x-ratelimit-remaining");
  if (remaining !== null && Number.parseInt(remaining, 10) === 0) return true;
  return message !== null && /rate limit|abuse detection|too many requests/i.test(message);
}

/** GitHub answers a duplicate ref with 422 "Reference already exists". */
function isAlreadyExists(error: SyncError): boolean {
  if (error.code !== "validation-failed" && error.code !== "conflict") return false;
  const haystack = [error.message, ...error.details].join(" ");
  return /already exists/i.test(haystack);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new SyncError("aborted", "Request cancelled before it was sent.");
  }
}

function isAbortError(cause: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true;
  if (cause instanceof Error && cause.name === "AbortError") return true;
  return false;
}

/** Encode one path segment; `/` is a separator and must survive. */
function seg(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Encode a slash-separated path or ref for a URL. Each segment is escaped
 * individually so `feature/x` and `public/locales/de.json` stay hierarchical
 * while `#`, `?` and spaces inside a segment cannot break out.
 */
function refPath(value: string): string {
  return value
    .split("/")
    .filter((part) => part.length > 0)
    .map(encodeURIComponent)
    .join("/");
}

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * UTF-8 → base64, which is the only encoding the contents API accepts.
 *
 * Written out rather than reaching for `btoa` (which throws on any code point
 * above U+00FF, i.e. on every non-Latin translation) or Node's `Buffer` (absent
 * in the browser and in edge runtimes).
 */
export function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    const remaining = bytes.length - i;
    out += BASE64_ALPHABET[(triplet >> 18) & 63] ?? "";
    out += BASE64_ALPHABET[(triplet >> 12) & 63] ?? "";
    out += remaining > 1 ? (BASE64_ALPHABET[(triplet >> 6) & 63] ?? "") : "=";
    out += remaining > 2 ? (BASE64_ALPHABET[triplet & 63] ?? "") : "=";
  }
  return out;
}
