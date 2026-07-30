import { describe, expect, it } from "vitest";
import type { SyncPlan, SyncTarget } from "@/lib/types";
import { describeSyncPlan, renderSyncPlanPreview } from "./dry-run";
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

const plan = buildSyncPlan(
  TARGET,
  [
    makeResult(catalog, "de", [{ key: "menu.save", target: "Speichern" }]),
    makeResult(catalog, "ja", [{ key: "menu.save", target: "保存" }]),
  ],
  catalog,
  { timestamp: Date.parse("2026-07-30T14:32:10Z") },
);

describe("describeSyncPlan", () => {
  const preview = describeSyncPlan(plan);

  it("names the repository, branch and PR before any credential exists", () => {
    expect(preview.repository).toBe("indiedev/deck-forge");
    expect(preview.branchName).toBe(plan.branchName);
    expect(preview.baseBranch).toBe("main");
    expect(preview.prTitle).toBe(plan.prTitle);
    expect(preview.commitSubject).toBe(plan.commitMessage.split("\n")[0]);
    expect(preview.prBody).toBe(plan.prBody);
  });

  it("lists every file with its path, size and line count", () => {
    expect(preview.files.map((file) => file.path)).toEqual([
      "public/locales/de.json",
      "public/locales/ja.json",
    ]);

    const first = preview.files[0];
    expect(first?.fileName).toBe("de.json");
    expect(first?.directory).toBe("public/locales");
    expect(first?.locale).toBe("de");
    expect(first?.bytes).toBe(
      new TextEncoder().encode(plan.files[0]?.contents ?? "").length,
    );
    expect(first?.sizeLabel).toMatch(/^\d+(\.\d)? (B|kB|MB)$/);
    expect(first?.lines).toBe((plan.files[0]?.contents ?? "").split("\n").length);
  });

  it("counts UTF-8 bytes, not code units", () => {
    const japanese = preview.files[1];
    const contents = plan.files[1]?.contents ?? "";
    expect(japanese?.bytes).toBeGreaterThan(contents.length);
  });

  it("totals the push", () => {
    expect(preview.fileCount).toBe(2);
    expect(preview.totalBytes).toBe(
      preview.files.reduce((sum, file) => sum + file.bytes, 0),
    );
    expect(preview.totalSizeLabel).toMatch(/kB|B/);
    expect(preview.summary).toContain("2 files");
    expect(preview.summary).toContain("indiedev/deck-forge");
  });

  it("spells out the API calls that would run, in order", () => {
    expect(preview.steps).toHaveLength(4);
    expect(preview.steps[0]).toContain("Create branch");
    expect(preview.steps[0]).toContain("from `main`");
    expect(preview.steps[1]).toContain("public/locales/de.json");
    expect(preview.steps[2]).toContain("public/locales/ja.json");
    expect(preview.steps[3]).toContain("pull request");
    expect(preview.steps[3]).toContain(plan.prTitle);
  });

  it("has nothing to warn about for a normal plan", () => {
    expect(preview.warnings).toEqual([]);
  });

  it("infers no locale when the pattern hides it", () => {
    const single = buildSyncPlan(
      { ...TARGET, fileNamePattern: "strings.json" },
      [makeResult(catalog, "de", [])],
      catalog,
      { timestamp: 0 },
    );
    expect(describeSyncPlan(single).files[0]?.locale).toBeNull();
  });
});

describe("describeSyncPlan — warnings", () => {
  function planWithFiles(files: SyncPlan["files"]): SyncPlan {
    return { ...plan, files };
  }

  it("flags a file too large for the contents API", () => {
    const preview = describeSyncPlan(
      planWithFiles([{ path: "locales/de.json", contents: "x".repeat(1_000_001) }]),
    );
    expect(preview.warnings[0]).toContain("1 MB");
    expect(preview.files[0]?.sizeLabel).toBe("1.0 MB");
  });

  it("flags duplicate paths", () => {
    const preview = describeSyncPlan(
      planWithFiles([
        { path: "locales/de.json", contents: "{}" },
        { path: "locales/de.json", contents: "{}" },
      ]),
    );
    expect(preview.warnings[0]).toContain("more than once");
  });

  it("says plainly when there is nothing to push", () => {
    const preview = describeSyncPlan(planWithFiles([]));
    expect(preview.fileCount).toBe(0);
    expect(preview.summary).toContain("Nothing to push");
    expect(preview.warnings[0]).toContain("no files");
  });
});

describe("renderSyncPlanPreview", () => {
  const text = renderSyncPlanPreview(plan);

  it("renders an aligned, credential-free summary", () => {
    expect(text).toContain("Repository   indiedev/deck-forge");
    expect(text).toContain(`Branch       ${plan.branchName} → main`);
    expect(text).toContain("public/locales/de.json");
    expect(text).toContain("Would run:");
    expect(text).toContain("  1. Create branch");
    expect(text).not.toContain("`");
  });

  it("accepts an already-computed preview", () => {
    expect(renderSyncPlanPreview(describeSyncPlan(plan))).toBe(text);
  });

  it("lists warnings when there are any", () => {
    const rendered = renderSyncPlanPreview({ ...plan, files: [] });
    expect(rendered).toContain("No files.");
    expect(rendered).toContain("Warnings:");
  });
});
