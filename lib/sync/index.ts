/**
 * LingoLoop sync — a finished run as a reviewable pull request.
 *
 * The shape a caller normally uses:
 *
 *   1. `buildSyncPlan(target, results, catalog, { timestamp })`  pure, testable
 *   2. `describeSyncPlan(plan)`                                  what would happen
 *   3. `new GitHubRestAdapter({ token })`                        the credential
 *   4. `executeSyncPlan(plan, adapter)`                          the push
 *
 * Steps 1–2 need no credentials and are what the MVP ships; steps 3–4 are real
 * and complete, so enabling sync is a configuration change, not a code change.
 */

export {
  buildSyncPlan,
  buildSyncPlanDetailed,
  buildBranchName,
  fingerprintRun,
  sanitizeRefComponent,
} from "./plan";
export type {
  BuildSyncPlanOptions,
  BranchNameInput,
  FitRow,
  SyncFileReport,
  SyncPlanReport,
  SyncPlanTotals,
} from "./plan";

export {
  assertSafeRepoPath,
  normalizeLocaleDir,
  resolveLocalePath,
  resolveLocalePaths,
} from "./paths";
export type { ResolvedLocaleFile } from "./paths";

export { describeSyncPlan, renderSyncPlanPreview } from "./dry-run";
export type { SyncFilePreview, SyncPlanPreview } from "./dry-run";

export { GitHubRestAdapter, encodeBase64 } from "./adapter";
export type {
  BranchRef,
  CommitRef,
  CreateBranchInput,
  FetchLike,
  GitHubAdapterOptions,
  OpenPullRequestInput,
  PullRequestRef,
  PutFileInput,
  RepoRef,
  SyncAdapter,
} from "./adapter";

export { executeSyncPlan } from "./execute";
export type {
  ExecuteSyncOptions,
  SyncFileOutcome,
  SyncOutcome,
  SyncProgress,
  SyncStepKind,
} from "./execute";

export { SyncError, SyncPlanError, toSyncError } from "./errors";
export type {
  RateLimitSnapshot,
  SyncErrorCode,
  SyncErrorInit,
  SyncPlanErrorCode,
} from "./errors";
