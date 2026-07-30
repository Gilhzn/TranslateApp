/**
 * The preview the MVP actually ships.
 *
 * With no token configured there is nothing to push, but the developer still
 * has to be able to answer "what exactly would land in my repo?" before they
 * hand over a credential. This turns a plan into that answer: every path, every
 * byte count, the branch, the PR title and the exact sequence of API calls that
 * would run — computed from the same plan the push would consume, so the
 * preview cannot describe something other than what would happen.
 */

import { inferLocaleFromFileName } from "@/lib/core";
import { byteLength, formatBytes } from "@/lib/export";
import type { LocaleCode, SyncPlan } from "@/lib/types";

export interface SyncFilePreview {
  /** Repository-relative path, e.g. `public/locales/de.json`. */
  path: string;
  /** Final path segment, e.g. `de.json`. */
  fileName: string;
  /** Directory portion; empty at the repository root. */
  directory: string;
  /** Locale inferred from the file name; null when the pattern hides it. */
  locale: LocaleCode | null;
  /** UTF-8 size of the contents. */
  bytes: number;
  /** `12.4 kB` — SI units, matching what a file manager shows. */
  sizeLabel: string;
  lines: number;
}

export interface SyncPlanPreview {
  /** `owner/repo`. */
  repository: string;
  branchName: string;
  baseBranch: string;
  prTitle: string;
  /** First line of the commit message. */
  commitSubject: string;
  /** Full commit message, for the "show details" disclosure. */
  commitMessage: string;
  /** Rendered PR body, so the UI can preview the review surface too. */
  prBody: string;
  files: SyncFilePreview[];
  fileCount: number;
  totalBytes: number;
  totalSizeLabel: string;
  /** One line per API call the push would make, in order. */
  steps: string[];
  /** Things that are legal but worth seeing before granting write access. */
  warnings: string[];
  /** One-line summary for a collapsed panel. */
  summary: string;
}

/**
 * GitHub's contents API is documented for files up to 1 MB; above that the
 * blob + tree API is required. A locale file that large is unusual enough to
 * be worth flagging rather than silently failing at push time.
 */
const CONTENTS_API_LIMIT = 1_000_000;

/** Describe exactly what pushing this plan would do. Pure; touches nothing. */
export function describeSyncPlan(plan: SyncPlan): SyncPlanPreview {
  const files: SyncFilePreview[] = plan.files.map((file) => {
    const slash = file.path.lastIndexOf("/");
    const fileName = slash === -1 ? file.path : file.path.slice(slash + 1);
    const directory = slash === -1 ? "" : file.path.slice(0, slash);
    const bytes = byteLength(file.contents);
    return {
      path: file.path,
      fileName,
      directory,
      locale: inferLocaleFromFileName(file.path),
      bytes,
      sizeLabel: formatBytes(bytes),
      // A file with no trailing newline still has a last line.
      lines: file.contents.length === 0 ? 0 : file.contents.split(/\r\n|\n/).length,
    };
  });

  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const repository = `${plan.target.owner}/${plan.target.repo}`;
  const commitSubject = plan.commitMessage.split("\n")[0] ?? plan.commitMessage;

  const steps: string[] = [
    `Create branch \`${plan.branchName}\` from \`${plan.target.baseBranch}\``,
    ...files.map(
      (file) => `Commit \`${file.path}\` (${file.sizeLabel}) to \`${plan.branchName}\``,
    ),
    `Open a pull request into \`${plan.target.baseBranch}\`: "${plan.prTitle}"`,
  ];

  const warnings: string[] = [];
  for (const file of files) {
    if (file.bytes > CONTENTS_API_LIMIT) {
      warnings.push(
        `${file.path} is ${file.sizeLabel}; files over 1 MB cannot be written through the contents API.`,
      );
    }
  }
  const duplicates = findDuplicates(files.map((file) => file.path));
  for (const path of duplicates) {
    warnings.push(`${path} appears more than once; the later write would win.`);
  }
  if (files.length === 0) {
    warnings.push("This plan contains no files, so there would be nothing to push.");
  }

  const summary =
    files.length === 0
      ? `Nothing to push to ${repository}`
      : `${files.length} ${files.length === 1 ? "file" : "files"} · ${formatBytes(totalBytes)} → ${repository}`;

  return {
    repository,
    branchName: plan.branchName,
    baseBranch: plan.target.baseBranch,
    prTitle: plan.prTitle,
    commitSubject,
    commitMessage: plan.commitMessage,
    prBody: plan.prBody,
    files,
    fileCount: files.length,
    totalBytes,
    totalSizeLabel: formatBytes(totalBytes),
    steps,
    warnings,
    summary,
  };
}

/**
 * The same preview as a plain-text block, for a `<pre>`, a copy-to-clipboard
 * button or a CLI. Paths are column-aligned so sizes read as a column.
 */
export function renderSyncPlanPreview(plan: SyncPlan | SyncPlanPreview): string {
  const preview = isPreview(plan) ? plan : describeSyncPlan(plan);
  const lines: string[] = [];

  const field = (label: string, value: string): string =>
    `${label.padEnd(13, " ")}${value}`;
  lines.push(field("Repository", preview.repository));
  lines.push(field("Branch", `${preview.branchName} → ${preview.baseBranch}`));
  lines.push(field("Commit", preview.commitSubject));
  lines.push(field("Pull request", preview.prTitle));
  lines.push("");

  if (preview.files.length === 0) {
    lines.push("No files.");
  } else {
    const width = preview.files.reduce(
      (max, file) => Math.max(max, file.path.length),
      0,
    );
    lines.push(`Files (${preview.fileCount}, ${preview.totalSizeLabel})`);
    for (const file of preview.files) {
      const size = file.sizeLabel.padStart(8, " ");
      lines.push(`  ${file.path.padEnd(width, " ")}  ${size}  ${file.lines} lines`);
    }
  }

  lines.push("");
  lines.push("Would run:");
  preview.steps.forEach((step, index) => {
    lines.push(`  ${index + 1}. ${stripMarkdown(step)}`);
  });

  if (preview.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of preview.warnings) lines.push(`  ! ${warning}`);
  }

  return lines.join("\n");
}

function isPreview(value: SyncPlan | SyncPlanPreview): value is SyncPlanPreview {
  return "steps" in value;
}

function stripMarkdown(text: string): string {
  return text.replace(/`/g, "");
}

function findDuplicates(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) duplicates.add(path);
    seen.add(path);
  }
  return [...duplicates];
}
