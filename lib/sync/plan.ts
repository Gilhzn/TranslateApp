/**
 * Turning a finished translation run into a reviewable pull request.
 *
 * Everything here is pure: no clock, no network, no randomness. The timestamp
 * that names the branch is a parameter, so the same run planned twice produces
 * byte-identical output and a retry after a failed push can deliberately reuse
 * the same branch by passing the job's start time again.
 *
 * File contents are produced by `@/lib/export`, not re-implemented here. That
 * is what makes a synced file and a downloaded file byte-identical — same
 * serialiser, same layout enforcement, same emitted-bytes validation — rather
 * than two implementations that agree until one of them is edited.
 */

import { serializeWithCatalogFormatting } from "@/lib/core";
import {
  byteLength,
  serializeLocaleResultDetailed,
  type ClippedEntry,
  type ExportCatalog,
  type SerializedLocale,
} from "@/lib/export";
import { getLocaleProfile } from "@/lib/layout";
import type {
  ExportFile,
  FitVerdict,
  Issue,
  LocaleCode,
  LocaleResult,
  SyncPlan,
  SyncTarget,
  ToneProfile,
  TranslatedEntry,
} from "@/lib/types";
import { SyncPlanError } from "./errors";
import { resolveLocalePaths, type ResolvedLocaleFile } from "./paths";

// ---------------------------------------------------------------------------
// Options and report shapes
// ---------------------------------------------------------------------------

export interface BuildSyncPlanOptions {
  /**
   * Epoch milliseconds, supplied by the caller so this stays a pure function.
   * Pass the job's `startedAt` when a retry should reuse the same branch.
   */
  timestamp: number;
  /** Branch namespace. Defaults to `lingoloop`. */
  branchPrefix?: string;
  /**
   * Clip entries whose recorded fit still says `overflow` before writing.
   * On by default — quality bar #1 is enforced at the file, not warned about.
   */
  enforceLayout?: boolean;
  /** Rows in the "tightest strings" table. Defaults to 10. */
  maxFitRows?: number;
  /** Rows in the "needs a human" tables. Defaults to 10. */
  maxAttentionRows?: number;
  /** Register the run used, surfaced in the PR body. */
  tone?: ToneProfile;
  /** Free-text product description the run was given. */
  productContext?: string;
  /** e.g. "Claude (claude-sonnet-4-5)" — which engine produced the strings. */
  providerLabel?: string;
  /** Deep link back into the LingoLoop review table for this job. */
  reviewUrl?: string;
  /**
   * Hard ceiling on the PR body. GitHub rejects bodies over 65 536 characters
   * with a 422, which would fail the push at the very last step; a truncated
   * body is strictly better than a lost pull request.
   */
  maxBodyLength?: number;
}

/** One planned file, with everything the UI or the PR body needs about it. */
export interface SyncFileReport {
  locale: LocaleCode;
  /** English name of the locale, e.g. "German". */
  localeName: string;
  path: string;
  fileName: string;
  /** UTF-8 size of the emitted contents. */
  bytes: number;
  stats: LocaleResult["stats"];
  /** Entries the export had to shorten to respect their layout budget. */
  clipped: ClippedEntry[];
  /** Keys whose blank translation fell back to the source string. */
  fellBack: string[];
  /** Non-blocking findings raised while validating the emitted bytes. */
  issues: Issue[];
}

/** One row of the "tightest strings" table. */
export interface FitRow {
  locale: LocaleCode;
  key: string;
  source: string;
  target: string;
  ratio: number;
  verdict: FitVerdict;
  /** True when the export shortened this string to make it fit. */
  clipped: boolean;
  /** The text this PR actually contains — the clipped form when clipped. */
  shipped: string;
}

export interface SyncPlanTotals {
  locales: number;
  strings: number;
  passed: number;
  flagged: number;
  failed: number;
  /** Strings the repair loop rewrote because they overflowed. */
  overflowRepaired: number;
  /** Strings the export clipped as a last resort. */
  clipped: number;
  /** Strings whose blank translation fell back to the source. */
  fellBack: number;
  bytes: number;
}

export interface SyncPlanReport {
  plan: SyncPlan;
  files: SyncFileReport[];
  totals: SyncPlanTotals;
  /** Stable identifier for these inputs; also the branch-name suffix. */
  fingerprint: string;
  worstFits: FitRow[];
}

const DEFAULT_PREFIX = "lingoloop";
const DEFAULT_FIT_ROWS = 10;
const DEFAULT_ATTENTION_ROWS = 10;
/** Git's own subject-line convention, and where GitHub truncates the list. */
const MAX_SUBJECT_LENGTH = 72;
/** GitHub's documented maximum pull request body length. */
const MAX_PR_BODY_LENGTH = 65_536;

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Build the pull request for a finished run.
 *
 * @throws {SyncPlanError} for unusable configuration (traversing paths,
 * colliding file names, an empty locale set, a non-finite timestamp).
 */
export function buildSyncPlan(
  target: SyncTarget,
  results: readonly LocaleResult[],
  catalog: ExportCatalog,
  options: BuildSyncPlanOptions,
): SyncPlan {
  return buildSyncPlanDetailed(target, results, catalog, options).plan;
}

/**
 * Build the pull request *and* the numbers behind it, for the UI's dry-run and
 * result panels. {@link buildSyncPlan} is this with the extras dropped.
 */
export function buildSyncPlanDetailed(
  target: SyncTarget,
  results: readonly LocaleResult[],
  catalog: ExportCatalog,
  options: BuildSyncPlanOptions,
): SyncPlanReport {
  assertTarget(target);
  if (results.length === 0) {
    throw new SyncPlanError(
      "no-locales",
      "Nothing to sync: the run produced no locale results.",
    );
  }
  if (!Number.isFinite(options.timestamp)) {
    throw new SyncPlanError(
      "invalid-timestamp",
      `Sync plans take an explicit timestamp; received ${String(options.timestamp)}.`,
    );
  }

  const enforceLayout = options.enforceLayout ?? true;
  const locales = results.map((result) => result.locale);
  const paths = resolveLocalePaths(target, locales);

  const files: ExportFile[] = [];
  const reports: SyncFileReport[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const resolved = paths[i];
    // `paths` is built from `results` above, so both indices exist; the guard
    // is here because noUncheckedIndexedAccess cannot know that.
    if (result === undefined || resolved === undefined) continue;
    const built = buildLocaleFile(catalog, result, resolved, enforceLayout);
    files.push(built.file);
    reports.push(built.report);
  }

  const totals = sumTotals(reports);
  const worstFits = collectWorstFits(
    results,
    reports,
    options.maxFitRows ?? DEFAULT_FIT_ROWS,
  );

  const fingerprint = fingerprintRun({
    catalog,
    target,
    locales,
    timestamp: options.timestamp,
  });

  const branchName = buildBranchName({
    prefix: options.branchPrefix ?? DEFAULT_PREFIX,
    locales,
    timestamp: options.timestamp,
    fingerprint,
  });

  const plan: SyncPlan = {
    target,
    branchName,
    commitMessage: buildCommitMessage(catalog.fileName, reports, totals),
    prTitle: buildPrTitle(catalog.fileName, reports, totals),
    prBody: buildPrBody({
      target,
      catalog,
      branchName,
      reports,
      totals,
      worstFits,
      results,
      options,
      enforceLayout,
    }),
    files,
  };

  return { plan, files: reports, totals, fingerprint, worstFits };
}

// ---------------------------------------------------------------------------
// Branch naming
// ---------------------------------------------------------------------------

export interface BranchNameInput {
  prefix: string;
  locales: readonly LocaleCode[];
  /** Epoch milliseconds. */
  timestamp: number;
  /** Precomputed content fingerprint; see {@link fingerprintRun}. */
  fingerprint: string;
}

/**
 * `lingoloop/20260730-1432-de-fr-ja-8a41c0d2f3`
 *
 * Sorted, UTC and fingerprinted, so identical inputs always produce the same
 * name and different runs never collide on one branch.
 */
export function buildBranchName(input: BranchNameInput): string {
  const prefix = sanitizeRefComponent(input.prefix) || DEFAULT_PREFIX;
  const stamp = utcStamp(input.timestamp);

  const unique = [...new Set(input.locales)].sort();
  const localePart =
    unique.length === 0
      ? "no-locales"
      : unique.length <= 3
        ? unique.map((l) => sanitizeRefComponent(l) || "x").join("-")
        : `${unique.length}-locales`;

  return `${prefix}/${stamp}-${localePart}-${input.fingerprint}`;
}

/**
 * A stable 10-hex-character digest of everything that defines this push:
 * the source bytes, the target locales, the repository coordinates and the
 * caller's timestamp.
 */
export function fingerprintRun(input: {
  catalog: ExportCatalog;
  target: SyncTarget;
  locales: readonly LocaleCode[];
  timestamp: number;
}): string {
  // The *source* file is hashed rather than the translations: it is what the
  // developer recognises, and it keeps the branch stable across a re-translate
  // of the same input at the same timestamp.
  const sourceBytes = serializeWithCatalogFormatting(
    input.catalog,
    input.catalog.tree,
  );
  return digest([
    input.catalog.fileName,
    input.catalog.sourceLocale,
    sourceBytes,
    [...input.locales].sort().join(","),
    `${input.target.owner}/${input.target.repo}@${input.target.baseBranch}`,
    input.target.localeDir,
    input.target.fileNamePattern,
    String(Math.trunc(input.timestamp)),
  ]);
}

/**
 * FNV-1a, run twice with different offset bases and interleaved into one
 * digest. Not cryptographic — this only has to be stable and collision-free
 * enough to name branches, and shipping a hash implementation beats adding a
 * dependency or reaching for WebCrypto's async API in a pure function.
 */
function digest(parts: readonly string[]): string {
  const joined = parts.join("\u0000");
  const a = fnv1a(joined, 0x811c9dc5);
  const b = fnv1a(joined, 0x01000193);
  return `${hex8(a)}${hex8(b)}`.slice(0, 10);
}

function fnv1a(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime (16777619) by shift-add: a plain multiply would lose
    // the low bits to float64 rounding.
    hash =
      (hash +
        ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>>
      0;
  }
  return hash >>> 0;
}

function hex8(value: number): string {
  return value.toString(16).padStart(8, "0");
}

/** `20260730-1432`, always UTC so two machines agree. */
function utcStamp(timestamp: number): string {
  const date = new Date(Math.trunc(timestamp));
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`
  );
}

/**
 * Reduce a string to something git will accept inside a ref name.
 *
 * git-check-ref-format forbids control characters, space, `~^:?*[\`, `..`,
 * `@{`, a leading or trailing `.`, and a `.lock` suffix. Slashes are kept in
 * the prefix so `team/lingoloop` still works.
 */
export function sanitizeRefComponent(raw: string): string {
  const collapsed = raw
    .trim()
    .toLowerCase()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/\/{2,}/g, "/");

  return collapsed
    .replace(/\.lock(?=$|\/)/g, "-lock")
    .replace(/^[-./]+/, "")
    .replace(/[-./]+$/, "");
}

// ---------------------------------------------------------------------------
// File building
// ---------------------------------------------------------------------------

function buildLocaleFile(
  catalog: ExportCatalog,
  result: LocaleResult,
  resolved: ResolvedLocaleFile,
  enforceLayout: boolean,
): { file: ExportFile; report: SyncFileReport } {
  let serialized: SerializedLocale;
  try {
    serialized = serializeLocaleResultDetailed(catalog, result, {
      // The path was already resolved and traversal-checked, so the export
      // module is asked only for bytes; its own path output is discarded in
      // favour of the checked one.
      pattern: resolved.fileName,
      enforceLayout,
    });
  } catch (cause) {
    throw new SyncPlanError(
      "serialize-failed",
      `Refusing to sync ${resolved.path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { input: resolved.path, cause },
    );
  }

  const file: ExportFile = {
    path: resolved.path,
    contents: serialized.file.contents,
  };

  return {
    file,
    report: {
      locale: result.locale,
      localeName: getLocaleProfile(result.locale).name,
      path: resolved.path,
      fileName: resolved.fileName,
      bytes: byteLength(file.contents),
      stats: result.stats,
      clipped: serialized.clipped,
      fellBack: serialized.fellBack,
      issues: serialized.issues,
    },
  };
}

function sumTotals(reports: readonly SyncFileReport[]): SyncPlanTotals {
  const totals: SyncPlanTotals = {
    locales: reports.length,
    strings: 0,
    passed: 0,
    flagged: 0,
    failed: 0,
    overflowRepaired: 0,
    clipped: 0,
    fellBack: 0,
    bytes: 0,
  };
  for (const report of reports) {
    totals.strings += report.stats.total;
    totals.passed += report.stats.passed;
    totals.flagged += report.stats.flagged;
    totals.failed += report.stats.failed;
    totals.overflowRepaired += report.stats.overflowRepaired;
    totals.clipped += report.clipped.length;
    totals.fellBack += report.fellBack.length;
    totals.bytes += report.bytes;
  }
  return totals;
}

function collectWorstFits(
  results: readonly LocaleResult[],
  reports: readonly SyncFileReport[],
  limit: number,
): FitRow[] {
  const clippedText = new Map<string, Map<string, string>>();
  for (const report of reports) {
    clippedText.set(
      report.locale,
      new Map(report.clipped.map((entry) => [entry.key, entry.after])),
    );
  }

  const rows: FitRow[] = [];
  for (const result of results) {
    const clipped = clippedText.get(result.locale);
    for (const entry of result.entries) {
      const fit = entry.fit;
      if (fit === null || fit.verdict === "fits") continue;
      const after = clipped?.get(entry.key);
      rows.push({
        locale: result.locale,
        key: entry.key,
        source: entry.source,
        target: entry.target,
        ratio: fit.ratio,
        verdict: fit.verdict,
        clipped: after !== undefined,
        shipped: after ?? entry.target,
      });
    }
  }

  rows.sort((a, b) => b.ratio - a.ratio || a.key.localeCompare(b.key));
  return rows.slice(0, Math.max(0, limit));
}

// ---------------------------------------------------------------------------
// Commit message and PR copy
// ---------------------------------------------------------------------------

function localeList(reports: readonly SyncFileReport[]): string {
  return reports.map((report) => report.locale).join(", ");
}

function buildCommitMessage(
  sourceFileName: string,
  reports: readonly SyncFileReport[],
  totals: SyncPlanTotals,
): string {
  const list = localeList(reports);
  const long = `i18n: translate ${totals.strings} strings into ${list}`;
  const subject =
    long.length <= MAX_SUBJECT_LENGTH
      ? long
      : `i18n: translate ${totals.strings} strings into ${totals.locales} locales`;

  const lines: string[] = [subject, ""];
  lines.push(`Source: ${sourceFileName}`);
  lines.push("");
  for (const report of reports) {
    const parts = [
      `${report.stats.passed} passed`,
      `${report.stats.flagged} flagged`,
      `${report.stats.failed} failed`,
    ];
    if (report.stats.overflowRepaired > 0) {
      parts.push(`${report.stats.overflowRepaired} shortened for layout`);
    }
    if (report.clipped.length > 0) {
      parts.push(`${report.clipped.length} clipped on export`);
    }
    lines.push(`  ${report.locale.padEnd(6)} ${report.path} — ${parts.join(", ")}`);
  }
  lines.push("");
  lines.push("Generated by LingoLoop.");
  return lines.join("\n");
}

function buildPrTitle(
  sourceFileName: string,
  reports: readonly SyncFileReport[],
  totals: SyncPlanTotals,
): string {
  const names = reports.map((report) => report.localeName);
  const subject =
    names.length <= 3
      ? `i18n: ${formatList(names)} translations for ${sourceFileName}`
      : `i18n: ${names.length} locale updates for ${sourceFileName}`;

  if (subject.length <= MAX_SUBJECT_LENGTH) return subject;
  return `i18n: ${totals.locales} locale updates (${totals.strings} strings)`;
}

function formatList(items: readonly string[]): string {
  if (items.length === 0) return "no locales";
  if (items.length === 1) return items[0] ?? "";
  const head = items.slice(0, -1).join(", ");
  return `${head} and ${items[items.length - 1] ?? ""}`;
}

interface PrBodyInput {
  target: SyncTarget;
  catalog: ExportCatalog;
  branchName: string;
  reports: readonly SyncFileReport[];
  totals: SyncPlanTotals;
  worstFits: readonly FitRow[];
  results: readonly LocaleResult[];
  options: BuildSyncPlanOptions;
  enforceLayout: boolean;
}

/**
 * The PR body is the developer's entire review surface — nobody diffs 300
 * translated strings by eye. It has to answer, in order: what changed, is it
 * safe, and what still needs a human.
 */
function buildPrBody(input: PrBodyInput): string {
  const { totals, reports, options } = input;
  const out: string[] = [];

  out.push(
    `Machine-translated by **LingoLoop** from \`${input.catalog.fileName}\` (${input.catalog.sourceLocale}) into ${totals.locales} ${plural(totals.locales, "locale")}: ${totals.strings} ${plural(totals.strings, "string")} across ${reports.length} ${plural(reports.length, "file")}.`,
  );
  out.push("");

  // At a glance -------------------------------------------------------------
  const facts: Array<[string, string]> = [
    ["Source", `\`${input.catalog.fileName}\` (${input.catalog.sourceLocale})`],
    ["Target", `\`${input.target.owner}/${input.target.repo}\``],
    ["Branch", `\`${input.branchName}\` → \`${input.target.baseBranch}\``],
    [
      "Result",
      `${totals.passed} passed · ${totals.flagged} flagged · ${totals.failed} failed`,
    ],
  ];
  if (options.tone !== undefined) facts.push(["Register", `\`${options.tone}\``]);
  if (options.productContext !== undefined && options.productContext.trim().length > 0) {
    facts.push(["Product context", truncate(options.productContext.trim(), 160)]);
  }
  if (options.providerLabel !== undefined) {
    facts.push(["Engine", options.providerLabel]);
  }
  for (const [label, value] of facts) {
    out.push(`- **${label}:** ${value}`);
  }
  out.push("");

  // Per-locale table --------------------------------------------------------
  out.push("## Locales");
  out.push("");
  out.push(
    "| Locale | File | Strings | Passed | Flagged | Failed | Shortened | Avg. width |",
  );
  out.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const report of reports) {
    const shortened = report.stats.overflowRepaired + report.clipped.length;
    out.push(
      `| ${cell(`${report.localeName} (${report.locale})`)} | ${cell(`\`${report.path}\``)} | ${report.stats.total} | ${report.stats.passed} | ${report.stats.flagged} | ${report.stats.failed} | ${shortened} | ${formatRatio(report.stats.averageRatio)} |`,
    );
  }
  out.push("");

  // Layout ------------------------------------------------------------------
  out.push("## Layout");
  out.push("");
  if (input.enforceLayout) {
    out.push(
      "Every string was measured against the length budget for its UI role and, where a translation ran long, either re-translated shorter or clipped before this file was written. **No string in this PR exceeds its budget.**",
    );
  } else {
    out.push(
      "⚠️ Layout enforcement was **disabled** for this run: translations are exactly as the model produced them and may overflow their UI.",
    );
  }
  out.push("");
  out.push(
    `- Re-translated to fit: **${totals.overflowRepaired}**`,
  );
  out.push(`- Clipped as a last resort: **${totals.clipped}**`);
  if (totals.fellBack > 0) {
    out.push(
      `- Fell back to the source string (empty translation): **${totals.fellBack}**`,
    );
  }
  out.push("");

  const clippedRows = input.reports.flatMap((report) =>
    report.clipped.map((entry) => ({ locale: report.locale, entry })),
  );
  if (clippedRows.length > 0) {
    const limit = options.maxAttentionRows ?? DEFAULT_ATTENTION_ROWS;
    out.push("<details>");
    out.push(
      `<summary>Clipped strings (${clippedRows.length}) — worth a native speaker's eye</summary>`,
    );
    out.push("");
    out.push("| Locale | Key | Before | After |");
    out.push("| --- | --- | --- | --- |");
    for (const row of clippedRows.slice(0, limit)) {
      out.push(
        `| ${cell(row.locale)} | ${cell(`\`${row.entry.key}\``)} | ${cell(quote(row.entry.before))} | ${cell(quote(row.entry.after))} |`,
      );
    }
    if (clippedRows.length > limit) {
      out.push(`| … | ${clippedRows.length - limit} more | | |`);
    }
    out.push("");
    out.push("</details>");
    out.push("");
  }

  // Tightest strings --------------------------------------------------------
  out.push("## Tightest strings");
  out.push("");
  if (input.worstFits.length === 0) {
    out.push(
      "Every translated string fits its budget with room to spare. Nothing here needs a second look for length.",
    );
  } else {
    out.push(
      "The widest translations relative to their source. **Shipped** is the text actually in this PR; **width** is what the model first produced, measured against the source.",
    );
    out.push("");
    out.push("| Locale | Key | Source | Shipped | Width | Status |");
    out.push("| --- | --- | --- | --- | ---: | --- |");
    for (const row of input.worstFits) {
      out.push(
        `| ${cell(row.locale)} | ${cell(`\`${row.key}\``)} | ${cell(quote(row.source))} | ${cell(quote(row.shipped))} | ${formatRatio(row.ratio)} | ${cell(describeFit(row, input.enforceLayout))} |`,
      );
    }
  }
  out.push("");

  // Needs a human -----------------------------------------------------------
  const attention = collectAttention(
    input.results,
    options.maxAttentionRows ?? DEFAULT_ATTENTION_ROWS,
  );
  out.push("## Needs a human");
  out.push("");
  if (attention.rows.length === 0) {
    out.push(
      "No string failed and none was left untranslated. Flagged strings, if any, are warnings only — placeholders and structure are intact.",
    );
  } else {
    out.push(
      `${attention.total} ${plural(attention.total, "string")} could not be produced cleanly. The source value was kept for each, so the file is complete and nothing renders blank.`,
    );
    out.push("");
    out.push("| Locale | Key | Source | Why |");
    out.push("| --- | --- | --- | --- |");
    for (const row of attention.rows) {
      out.push(
        `| ${cell(row.locale)} | ${cell(`\`${row.key}\``)} | ${cell(quote(row.source))} | ${cell(row.reason)} |`,
      );
    }
    if (attention.total > attention.rows.length) {
      out.push(
        `| … | ${attention.total - attention.rows.length} more | | see the LingoLoop review table |`,
      );
    }
  }
  out.push("");

  // Issues ------------------------------------------------------------------
  const issueCounts = countIssues(input.results, input.reports);
  if (issueCounts.length > 0) {
    out.push("## Validation findings");
    out.push("");
    out.push("| Code | Severity | Count |");
    out.push("| --- | --- | ---: |");
    for (const row of issueCounts) {
      out.push(`| \`${row.code}\` | ${row.severity} | ${row.count} |`);
    }
    out.push("");
  }

  // Guarantees + checklist --------------------------------------------------
  out.push("## What was checked");
  out.push("");
  out.push(
    "- Structure is identical to the source: same keys, nesting, array lengths, non-string leaves, key order, indentation and line endings.",
  );
  out.push(
    "- Placeholders (`{count}`, `%s`, `<b>`, `$t(key)`) are present, unaltered and in a valid order in every translation.",
  );
  out.push("- The emitted JSON was re-parsed and diffed against the source tree before this plan was built.");
  out.push("");
  out.push("## Review checklist");
  out.push("");
  out.push("- [ ] Product and brand terms read the way you say them in-product");
  out.push("- [ ] Register matches the rest of the UI (not more formal than the English)");
  out.push("- [ ] The clipped and tightest strings above still make sense");
  if (totals.failed > 0) {
    out.push("- [ ] Decide what to do with the strings that could not be translated");
  }
  out.push("- [ ] Run the app in one target locale and look at the busiest screen");
  out.push("");

  out.push("---");
  const footer =
    options.reviewUrl !== undefined && options.reviewUrl.length > 0
      ? `[Open this run in LingoLoop](${options.reviewUrl})`
      : "Generated by LingoLoop.";
  out.push(footer);

  return clampBody(out.join("\n"), options.maxBodyLength ?? MAX_PR_BODY_LENGTH);
}

/** Cut an over-long body at a line boundary and say that it was cut. */
function clampBody(body: string, limit: number): string {
  if (body.length <= limit) return body;
  const notice =
    "\n\n---\n_Truncated: this run's summary is longer than a pull request body can hold. The full report is in LingoLoop._";
  const room = Math.max(0, limit - notice.length);
  const cut = body.slice(0, room);
  const lastBreak = cut.lastIndexOf("\n");
  return `${lastBreak > 0 ? cut.slice(0, lastBreak) : cut}${notice}`;
}

interface AttentionRow {
  locale: LocaleCode;
  key: string;
  source: string;
  reason: string;
}

function collectAttention(
  results: readonly LocaleResult[],
  limit: number,
): { rows: AttentionRow[]; total: number } {
  const rows: AttentionRow[] = [];
  let total = 0;
  for (const result of results) {
    for (const entry of result.entries) {
      if (entry.status !== "failed" && !isBlank(entry)) continue;
      total += 1;
      if (rows.length < limit) {
        rows.push({
          locale: result.locale,
          key: entry.key,
          source: entry.source,
          reason: describeFailure(entry),
        });
      }
    }
  }
  return { rows, total };
}

function isBlank(entry: TranslatedEntry): boolean {
  return entry.target.trim().length === 0 && entry.source.trim().length > 0;
}

function describeFailure(entry: TranslatedEntry): string {
  const blocking = entry.issues.find((issue) => issue.severity === "error");
  if (blocking !== undefined) return truncate(blocking.message, 120);
  const warning = entry.issues[0];
  if (warning !== undefined) return truncate(warning.message, 120);
  if (isBlank(entry)) return "empty translation; source value kept";
  return `status "${entry.status}" after ${entry.attempts} ${plural(entry.attempts, "attempt")}`;
}

function countIssues(
  results: readonly LocaleResult[],
  reports: readonly SyncFileReport[],
): Array<{ code: string; severity: string; count: number }> {
  const counts = new Map<string, { code: string; severity: string; count: number }>();
  const record = (issue: Issue): void => {
    const id = `${issue.code}\u0000${issue.severity}`;
    const existing = counts.get(id);
    if (existing === undefined) {
      counts.set(id, { code: issue.code, severity: issue.severity, count: 1 });
    } else {
      existing.count += 1;
    }
  };

  for (const result of results) {
    for (const issue of result.issues) record(issue);
    for (const entry of result.entries) {
      for (const issue of entry.issues) record(issue);
    }
  }
  for (const report of reports) {
    for (const issue of report.issues) record(issue);
  }

  const severityRank: Record<string, number> = { error: 0, warning: 1, info: 2 };
  return [...counts.values()].sort(
    (a, b) =>
      (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3) ||
      b.count - a.count ||
      a.code.localeCompare(b.code),
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function assertTarget(target: SyncTarget): void {
  const missing = (["owner", "repo", "baseBranch"] as const).filter(
    (field) => target[field].trim().length === 0,
  );
  if (missing.length > 0) {
    throw new SyncPlanError(
      "invalid-target",
      `Sync target is missing ${missing.join(", ")}.`,
    );
  }
}

/** Escape a markdown table cell: pipes break the row, newlines break the table. */
function cell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

/** Render a translated string inline, visibly quoted and length-capped. */
function quote(text: string): string {
  if (text.length === 0) return "*(empty)*";
  const flattened = text.replace(/\s+/g, " ").trim();
  const shortened = truncate(flattened, 56);
  // A value containing a backtick needs a longer fence than the value itself.
  const fence = "`".repeat(longestBacktickRun(shortened) + 1);
  const pad = shortened.startsWith("`") || shortened.endsWith("`") ? " " : "";
  return `${fence}${pad}${shortened}${pad}${fence}`;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  let current = 0;
  for (const char of text) {
    if (char === "`") {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** What happened to a string that did not fit outright. */
function describeFit(row: FitRow, enforceLayout: boolean): string {
  if (row.clipped) return "clipped to fit";
  if (row.verdict === "tight") return "fits, little headroom";
  // Recorded as overflowing, yet the export found nothing to cut: the string
  // was repaired after the fit was last measured.
  return enforceLayout
    ? "re-measured within budget"
    : "⚠️ over budget (enforcement off)";
}

function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return "—";
  return `${Math.round(ratio * 100)}%`;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}
