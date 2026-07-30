import { describe, expect, it } from "vitest";
import type { SyncPlan, SyncTarget } from "@/lib/types";
import type {
  BranchRef,
  CommitRef,
  CreateBranchInput,
  OpenPullRequestInput,
  PullRequestRef,
  PutFileInput,
  SyncAdapter,
} from "./adapter";
import { SyncError } from "./errors";
import { executeSyncPlan, type SyncProgress } from "./execute";
import { buildSyncPlan } from "./plan";
import { makeCatalog, makeResult } from "./testing";

const TARGET: SyncTarget = {
  provider: "github",
  owner: "indiedev",
  repo: "deck-forge",
  baseBranch: "main",
  localeDir: "public/locales",
  fileNamePattern: "{locale}.json",
};

const catalog = makeCatalog();

function makePlan(locales: string[] = ["de", "ja"]): SyncPlan {
  return buildSyncPlan(
    TARGET,
    locales.map((locale) => makeResult(catalog, locale, [])),
    catalog,
    { timestamp: Date.parse("2026-07-30T14:32:10Z") },
  );
}

interface Recorder {
  adapter: SyncAdapter;
  branches: CreateBranchInput[];
  writes: PutFileInput[];
  pulls: OpenPullRequestInput[];
}

function recordingAdapter(
  overrides: Partial<SyncAdapter> & { configured?: boolean } = {},
): Recorder {
  const branches: CreateBranchInput[] = [];
  const writes: PutFileInput[] = [];
  const pulls: OpenPullRequestInput[] = [];

  const adapter: SyncAdapter = {
    id: "test",
    label: "Test host",
    isConfigured: () => overrides.configured ?? true,
    createBranch: async (input): Promise<BranchRef> => {
      branches.push(input);
      return { name: input.branchName, sha: "basesha", created: true };
    },
    putFile: async (input): Promise<CommitRef> => {
      writes.push(input);
      return {
        sha: `commit${writes.length}`,
        contentSha: `blob${writes.length}`,
        url: null,
        changed: true,
      };
    },
    openPullRequest: async (input): Promise<PullRequestRef> => {
      pulls.push(input);
      return { number: 12, url: "https://github.com/x/y/pull/12", state: "open", draft: false };
    },
    ...stripHelpers(overrides),
  };

  return { adapter, branches, writes, pulls };
}

function stripHelpers(
  overrides: Partial<SyncAdapter> & { configured?: boolean },
): Partial<SyncAdapter> {
  const { configured: _configured, ...rest } = overrides;
  return rest;
}

describe("executeSyncPlan", () => {
  it("creates the branch, writes every file in order, then opens the PR", async () => {
    const plan = makePlan();
    const recorder = recordingAdapter();
    const steps: SyncProgress[] = [];

    const outcome = await executeSyncPlan(plan, recorder.adapter, {
      onProgress: (progress) => steps.push(progress),
    });

    expect(recorder.branches).toEqual([
      {
        owner: "indiedev",
        repo: "deck-forge",
        baseBranch: "main",
        branchName: plan.branchName,
      },
    ]);
    expect(recorder.writes.map((write) => write.path)).toEqual([
      "public/locales/de.json",
      "public/locales/ja.json",
    ]);
    expect(recorder.writes.every((write) => write.branch === plan.branchName)).toBe(true);
    expect(recorder.pulls[0]).toMatchObject({
      head: plan.branchName,
      base: "main",
      title: plan.prTitle,
      body: plan.prBody,
    });
    expect(recorder.pulls[0]).not.toHaveProperty("draft");

    expect(outcome.branch.created).toBe(true);
    expect(outcome.files.map((file) => file.path)).toEqual([
      "public/locales/de.json",
      "public/locales/ja.json",
    ]);
    expect(outcome.pullRequest.number).toBe(12);

    expect(steps.map((step) => step.step)).toEqual([
      "branch",
      "file",
      "file",
      "pull-request",
    ]);
    expect(steps.map((step) => step.completed)).toEqual([1, 2, 3, 4]);
    expect(steps.every((step) => step.total === 4)).toBe(true);
    expect(steps[1]?.path).toBe("public/locales/de.json");
    expect(steps[3]?.label).toContain("#12");
  });

  it("uses the full commit message for a single file, and a scoped one otherwise", async () => {
    const single = makePlan(["de"]);
    const one = recordingAdapter();
    await executeSyncPlan(single, one.adapter);
    expect(one.writes[0]?.message).toBe(single.commitMessage);

    const many = makePlan();
    const two = recordingAdapter();
    await executeSyncPlan(many, two.adapter);
    const subject = many.commitMessage.split("\n")[0];
    expect(two.writes[0]?.message).toBe(`${subject} (public/locales/de.json)`);
    expect(two.writes[1]?.message).toBe(`${subject} (public/locales/ja.json)`);
  });

  it("passes draft through when asked", async () => {
    const recorder = recordingAdapter();
    await executeSyncPlan(makePlan(["de"]), recorder.adapter, { draft: true });
    expect(recorder.pulls[0]?.draft).toBe(true);
  });

  it("reports a reused branch honestly", async () => {
    const recorder = recordingAdapter({
      createBranch: async (input) => ({
        name: input.branchName,
        sha: "existing",
        created: false,
      }),
    });
    const steps: SyncProgress[] = [];
    await executeSyncPlan(makePlan(["de"]), recorder.adapter, {
      onProgress: (progress) => steps.push(progress),
    });
    expect(steps[0]?.label).toContain("Reusing existing branch");
  });

  it("refuses to start without credentials", async () => {
    const recorder = recordingAdapter({ configured: false });
    await expect(
      executeSyncPlan(makePlan(), recorder.adapter),
    ).rejects.toMatchObject({ code: "not-configured" });
    expect(recorder.branches).toHaveLength(0);
    expect(recorder.writes).toHaveLength(0);
  });

  it("stops at the first failed write and leaves the PR unopened", async () => {
    const recorder = recordingAdapter({
      putFile: async (input) => {
        if (input.path.endsWith("ja.json")) {
          throw new SyncError("conflict", "sha mismatch", { status: 409 });
        }
        return { sha: "c", contentSha: "b", url: null, changed: true };
      },
    });

    await expect(executeSyncPlan(makePlan(), recorder.adapter)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(recorder.pulls).toHaveLength(0);
  });

  it("wraps an unexpected adapter throw as a SyncError", async () => {
    const recorder = recordingAdapter({
      openPullRequest: async () => {
        throw new TypeError("undefined is not a function");
      },
    });

    try {
      await executeSyncPlan(makePlan(["de"]), recorder.adapter);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SyncError);
      expect((error as SyncError).code).toBe("unexpected");
      expect((error as SyncError).message).toContain("Could not open the pull request");
    }
  });

  it("forwards the abort signal to every call", async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const recorder = recordingAdapter({
      createBranch: async (input, signal) => {
        seen.push(signal);
        return { name: input.branchName, sha: "s", created: true };
      },
      putFile: async (_input, signal) => {
        seen.push(signal);
        return { sha: "c", contentSha: "b", url: null, changed: true };
      },
      openPullRequest: async (_input, signal) => {
        seen.push(signal);
        return { number: 1, url: "u", state: "open", draft: false };
      },
    });

    await executeSyncPlan(makePlan(["de"]), recorder.adapter, {
      signal: controller.signal,
    });
    expect(seen).toEqual([controller.signal, controller.signal, controller.signal]);
  });

  it("rejects a plan with no files", async () => {
    const recorder = recordingAdapter();
    await expect(
      executeSyncPlan({ ...makePlan(), files: [] }, recorder.adapter),
    ).rejects.toBeInstanceOf(SyncError);
  });
});
