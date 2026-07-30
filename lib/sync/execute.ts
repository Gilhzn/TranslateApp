/**
 * Running a {@link SyncPlan} against an adapter.
 *
 * Deliberately sequential: the contents API commits one file at a time onto the
 * same branch, and parallel writes race on the branch head and 409. The order
 * is branch → files (in plan order) → pull request, and every step is
 * cancellable between calls as well as inside them.
 */

import type { SyncPlan } from "@/lib/types";
import type { CommitRef, PullRequestRef, SyncAdapter, BranchRef } from "./adapter";
import { SyncError, toSyncError } from "./errors";

export type SyncStepKind = "branch" | "file" | "pull-request";

export interface SyncProgress {
  step: SyncStepKind;
  /** 1-based position across all steps, for a determinate progress bar. */
  completed: number;
  total: number;
  /** Human-readable line for the UI log. */
  label: string;
  /** Set for `file` steps. */
  path?: string;
}

export interface SyncFileOutcome {
  path: string;
  commit: CommitRef;
}

export interface SyncOutcome {
  branch: BranchRef;
  files: SyncFileOutcome[];
  pullRequest: PullRequestRef;
}

export interface ExecuteSyncOptions {
  signal?: AbortSignal;
  onProgress?: (progress: SyncProgress) => void;
  /** Open the PR as a draft. */
  draft?: boolean;
}

/**
 * Push the plan and open the pull request.
 *
 * @throws {SyncError} for every failure, including an unconfigured adapter —
 * the caller never sees a raw fetch rejection.
 */
export async function executeSyncPlan(
  plan: SyncPlan,
  adapter: SyncAdapter,
  options: ExecuteSyncOptions = {},
): Promise<SyncOutcome> {
  if (!adapter.isConfigured()) {
    throw new SyncError(
      "not-configured",
      `${adapter.label} has no credentials configured; nothing was pushed.`,
    );
  }
  if (plan.files.length === 0) {
    throw new SyncError("unexpected", "This plan contains no files to push.");
  }

  const { owner, repo, baseBranch } = plan.target;
  const signal = options.signal;
  const total = plan.files.length + 2;
  let completed = 0;

  const report = (step: SyncStepKind, label: string, path?: string): void => {
    completed += 1;
    const progress: SyncProgress = { step, completed, total, label };
    if (path !== undefined) progress.path = path;
    options.onProgress?.(progress);
  };

  const branch = await step(
    () =>
      adapter.createBranch(
        { owner, repo, baseBranch, branchName: plan.branchName },
        signal,
      ),
    `Could not create branch ${plan.branchName}`,
  );
  report(
    "branch",
    branch.created
      ? `Created ${plan.branchName} from ${baseBranch}`
      : `Reusing existing branch ${plan.branchName}`,
  );

  const single = plan.files.length === 1;
  const subject = plan.commitMessage.split("\n")[0] ?? plan.commitMessage;

  const files: SyncFileOutcome[] = [];
  for (const file of plan.files) {
    const commit = await step(
      () =>
        adapter.putFile(
          {
            owner,
            repo,
            branch: plan.branchName,
            path: file.path,
            contents: file.contents,
            // One commit per file, so a reviewer can read the history per
            // locale; the full run summary lives in the PR body.
            message: single ? plan.commitMessage : `${subject} (${file.path})`,
          },
          signal,
        ),
      `Could not write ${file.path}`,
    );
    files.push({ path: file.path, commit });
    report(
      "file",
      commit.changed ? `Wrote ${file.path}` : `${file.path} already up to date`,
      file.path,
    );
  }

  const pullRequest = await step(
    () =>
      adapter.openPullRequest(
        {
          owner,
          repo,
          head: plan.branchName,
          base: baseBranch,
          title: plan.prTitle,
          body: plan.prBody,
          ...(options.draft === true ? { draft: true } : {}),
        },
        signal,
      ),
    "Could not open the pull request",
  );
  report("pull-request", `Opened #${pullRequest.number}`);

  return { branch, files, pullRequest };
}

/** Run one adapter call, guaranteeing a {@link SyncError} on the way out. */
async function step<T>(run: () => Promise<T>, context: string): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw toSyncError(cause, context);
  }
}
