"use client";

import * as React from "react";
import { Badge, Progress, cn } from "@/components/ui";
import {
  ExportValidationError,
  buildLocaleArchive,
  byteLength,
  defaultArchiveName,
  downloadArchive,
  downloadExportFile,
  formatBytes,
  serializeLocaleResultDetailed,
  type ExportCatalog,
} from "@/lib/export";
import { getLocaleProfile } from "@/lib/layout";
import type { GlossaryTerm, Issue, LocaleCode, LocaleResult } from "@/lib/types";
import { ReviewTable } from "./ReviewTable";
import { ReviewToolbar, type LocaleOption } from "./ReviewToolbar";
import { ALL_FILTER, countRows, filterRows, type ReviewFilter } from "./filtering";
import { recomputeRow, revertRow, trimRowToFit, type RecomputeContext } from "./recompute";
import { buildRows, resultWithEdits, type ReviewRow } from "./rows";

/**
 * The whole review surface: summary, filters, table, export.
 *
 * State lives here because an edit has to be visible to three things at once —
 * the row's own badges, the facet counts in the toolbar, and the bytes the
 * export writes. Rows are the single source of truth; `LocaleResult` is
 * reconstructed from them at export time.
 */

export interface ReviewPanelProps {
  catalog: ExportCatalog;
  results: readonly LocaleResult[];
  sourceLocale?: LocaleCode;
  glossary?: readonly GlossaryTerm[];
  /** File-name pattern for exports; `{locale}` is substituted. */
  fileNamePattern?: string;
  /** Directory prefix inside the archive, e.g. `public/locales`. */
  exportDirectory?: string;
  /** Height of the table's scroll viewport, in pixels. */
  tableHeight?: number;
  className?: string;
}

type ExportState =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; message: string; detail?: string }
  | { kind: "error"; message: string; issues: readonly Issue[] };

export function ReviewPanel({
  catalog,
  results,
  sourceLocale = catalog.sourceLocale,
  glossary,
  fileNamePattern = "{locale}.json",
  exportDirectory = "",
  tableHeight = 560,
  className,
}: ReviewPanelProps) {
  const [rowSource, setRowSource] = React.useState(results);
  const [rows, setRows] = React.useState<ReviewRow[]>(() =>
    buildRows(catalog, results),
  );
  const [filter, setFilter] = React.useState<ReviewFilter>(ALL_FILTER);
  const [exportState, setExportState] = React.useState<ExportState>({ kind: "idle" });

  // A fresh translation job replaces the rows, discarding overrides that no
  // longer refer to anything.
  if (rowSource !== results) {
    setRowSource(results);
    setRows(buildRows(catalog, results));
    setExportState({ kind: "idle" });
  }

  const searchRef = React.useRef<HTMLInputElement | null>(null);

  const contexts = React.useMemo(() => {
    const map = new Map<LocaleCode, RecomputeContext>();
    for (const result of results) {
      const context: RecomputeContext = {
        profile: getLocaleProfile(result.locale),
        sourceLocale,
      };
      if (glossary !== undefined) context.glossary = glossary;
      map.set(result.locale, context);
    }
    return map;
  }, [results, sourceLocale, glossary]);

  const fallbackContext = React.useMemo<RecomputeContext>(
    () => ({ profile: getLocaleProfile(sourceLocale), sourceLocale }),
    [sourceLocale],
  );

  const contextFor = React.useCallback(
    (locale: string): RecomputeContext => contexts.get(locale) ?? fallbackContext,
    [contexts, fallbackContext],
  );

  const localeOptions = React.useMemo<LocaleOption[]>(
    () =>
      results.map((result) => {
        const profile = getLocaleProfile(result.locale);
        return {
          code: result.locale,
          label: profile.nativeName,
          direction: profile.direction,
        };
      }),
    [results],
  );

  const visibleRows = React.useMemo(
    () => filterRows(rows, filter),
    [rows, filter],
  );
  const counts = React.useMemo(() => countRows(rows, filter), [rows, filter]);

  const replaceRow = React.useCallback((next: ReviewRow) => {
    setRows((current) =>
      current.map((row) => (row.id === next.id ? next : row)),
    );
  }, []);

  const handleEdit = React.useCallback(
    (row: ReviewRow, nextTarget: string) => {
      replaceRow(recomputeRow(row, nextTarget, contextFor(row.locale)));
    },
    [contextFor, replaceRow],
  );

  const handleRevert = React.useCallback(
    (row: ReviewRow) => {
      replaceRow(revertRow(row, contextFor(row.locale)));
    },
    [contextFor, replaceRow],
  );

  const handleTrim = React.useCallback(
    (row: ReviewRow) => {
      replaceRow(trimRowToFit(row, contextFor(row.locale)));
    },
    [contextFor, replaceRow],
  );

  const exportOptions = React.useMemo(
    () => ({ pattern: fileNamePattern, directory: exportDirectory }),
    [fileNamePattern, exportDirectory],
  );

  const handleExportLocale = React.useCallback(() => {
    if (filter.locale === "all") return;
    const result = results.find((candidate) => candidate.locale === filter.locale);
    if (result === undefined) return;

    setExportState({ kind: "working" });
    try {
      const serialized = serializeLocaleResultDetailed(
        catalog,
        resultWithEdits(result, rows),
        exportOptions,
      );
      downloadExportFile(serialized.file);
      setExportState({
        kind: "done",
        message: `Downloaded ${serialized.file.path} · ${formatBytes(
          byteLength(serialized.file.contents),
        )}`,
        detail: describeAdjustments(serialized.clipped.length, serialized.fellBack.length),
      });
    } catch (error) {
      setExportState(toErrorState(error));
    }
  }, [catalog, exportOptions, filter.locale, results, rows]);

  const handleExportAll = React.useCallback(() => {
    setExportState({ kind: "working" });
    try {
      const archive = buildLocaleArchive(
        catalog,
        results.map((result) => resultWithEdits(result, rows)),
        exportOptions,
      );
      const name = defaultArchiveName(catalog.fileName);
      downloadArchive(archive.bytes, name);
      setExportState({
        kind: "done",
        message: `Downloaded ${name} · ${archive.files.length} files · ${formatBytes(
          archive.bytes.length,
        )}`,
        detail: describeAdjustments(archive.clipped.length, archive.fellBack.length),
      });
    } catch (error) {
      setExportState(toErrorState(error));
    }
  }, [catalog, exportOptions, results, rows]);

  // "/" jumps to the search box, the way it does in every developer tool.
  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "/" || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return;
    }
    event.preventDefault();
    searchRef.current?.focus();
    searchRef.current?.select();
  };

  return (
    <div
      onKeyDown={handlePanelKeyDown}
      className={cn("flex flex-col gap-4", className)}
    >
      <SummaryStrip rows={rows} fileName={catalog.fileName} locales={results.length} />

      <ReviewToolbar
        filter={filter}
        onFilterChange={setFilter}
        counts={counts}
        locales={localeOptions}
        onExportLocale={handleExportLocale}
        onExportAll={handleExportAll}
        exporting={exportState.kind === "working"}
        searchRef={searchRef}
      />

      <ExportStatus state={exportState} />

      <ReviewTable
        rows={visibleRows}
        contextFor={contextFor}
        onEdit={handleEdit}
        onRevert={handleRevert}
        onTrim={handleTrim}
        showLocale={filter.locale === "all"}
        height={tableHeight}
      />

      <KeyboardHint />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function SummaryStrip({
  rows,
  fileName,
  locales,
}: {
  rows: readonly ReviewRow[];
  fileName: string;
  locales: number;
}) {
  const summary = React.useMemo(() => {
    let passed = 0;
    let flagged = 0;
    let failed = 0;
    let edited = 0;
    let overflow = 0;
    for (const row of rows) {
      if (row.status === "passed") passed += 1;
      else if (row.status === "flagged") flagged += 1;
      else if (row.status === "failed") failed += 1;
      if (row.edited) edited += 1;
      if (row.fit?.verdict === "overflow") overflow += 1;
    }
    return { passed, flagged, failed, edited, overflow, total: rows.length };
  }, [rows]);

  const rate = summary.total === 0 ? 0 : summary.passed / summary.total;

  return (
    <div className="surface-card flex flex-wrap items-center gap-x-8 gap-y-4 px-5 py-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <code className="font-[family-name:var(--font-mono)] text-[13px] text-[var(--text-primary)]">
            {fileName}
          </code>
          <Badge tone="neutral">{locales} locales</Badge>
        </div>
        <p className="mt-1 text-[12px] text-[var(--text-tertiary)]">
          {summary.total.toLocaleString()} strings reviewed
        </p>
      </div>

      <div className="min-w-[180px] flex-1">
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="text-[12px] text-[var(--text-tertiary)]">Clean on arrival</span>
          <span className="tabular text-[13px] font-medium text-[var(--text-primary)]">
            {Math.round(rate * 100)}%
          </span>
        </div>
        <Progress value={rate} label="Share of strings that passed every check" />
      </div>

      <dl className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Stat label="Passed" value={summary.passed} tone="ok" />
        <Stat label="Flagged" value={summary.flagged} tone="warn" />
        <Stat label="Failed" value={summary.failed} tone="danger" />
        <Stat label="Overflowing" value={summary.overflow} tone="danger" />
        <Stat label="Edited" value={summary.edited} tone="accent" />
      </dl>
    </div>
  );
}

const STAT_TONE = {
  ok: "var(--color-ok-400)",
  warn: "var(--color-warn-400)",
  danger: "var(--color-danger-400)",
  accent: "var(--color-accent-400)",
} as const;

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: keyof typeof STAT_TONE;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
        {label}
      </dt>
      <dd
        className="tabular text-[18px] font-semibold leading-none"
        style={{ color: value === 0 ? "var(--text-tertiary)" : STAT_TONE[tone] }}
      >
        {value.toLocaleString()}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Export feedback
// ---------------------------------------------------------------------------

function describeAdjustments(clipped: number, fellBack: number): string | undefined {
  const parts: string[] = [];
  if (clipped > 0) {
    parts.push(
      `${clipped} string${clipped === 1 ? "" : "s"} clipped to the layout budget`,
    );
  }
  if (fellBack > 0) {
    parts.push(
      `${fellBack} blank translation${fellBack === 1 ? "" : "s"} fell back to the source`,
    );
  }
  return parts.length === 0 ? undefined : `${parts.join(" · ")}.`;
}

function toErrorState(error: unknown): ExportState {
  if (error instanceof ExportValidationError) {
    return {
      kind: "error",
      message: `Export refused: ${error.path} failed validation.`,
      issues: error.issues,
    };
  }
  return {
    kind: "error",
    message: error instanceof Error ? error.message : String(error),
    issues: [],
  };
}

function ExportStatus({ state }: { state: ExportState }) {
  if (state.kind === "idle" || state.kind === "working") return null;

  const failed = state.kind === "error";

  return (
    <div
      role={failed ? "alert" : "status"}
      aria-live="polite"
      className={cn(
        "flex items-start gap-2.5 rounded-[var(--radius-md)] border px-3 py-2.5",
        failed
          ? "border-[color-mix(in_oklch,var(--color-danger-500)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-danger-500)_10%,transparent)]"
          : "border-[color-mix(in_oklch,var(--color-ok-500)_38%,transparent)] bg-[color-mix(in_oklch,var(--color-ok-500)_9%,transparent)]",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 h-2 w-2 shrink-0 rounded-full",
          failed ? "bg-[var(--color-danger-400)]" : "bg-[var(--color-ok-400)]",
        )}
      />
      <div className="min-w-0">
        <p
          className={cn(
            "text-[13px]",
            failed ? "text-[var(--color-danger-400)]" : "text-[var(--text-primary)]",
          )}
        >
          {state.kind === "error" ? state.message : state.message}
        </p>
        {state.kind === "done" && state.detail !== undefined && (
          <p className="mt-0.5 text-[12px] text-[var(--text-tertiary)]">
            {state.detail}
          </p>
        )}
        {state.kind === "error" && state.issues.length > 0 && (
          <ul className="mt-1.5 flex flex-col gap-1">
            {state.issues.slice(0, 4).map((issue, index) => (
              <li
                key={`${issue.code}-${index}`}
                className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)]"
              >
                {issue.code}: {issue.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function KeyboardHint() {
  const keys: Array<[string, string]> = [
    ["↑ ↓", "move"],
    ["Enter", "expand"],
    ["E", "edit"],
    ["Esc", "collapse"],
    ["/", "search"],
  ];

  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-[var(--text-tertiary)]">
      {keys.map(([key, action]) => (
        <span key={key} className="inline-flex items-center gap-1.5">
          <kbd className="rounded-[var(--radius-xs)] border border-[var(--border-subtle)] bg-[var(--surface-2)] px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-secondary)]">
            {key}
          </kbd>
          {action}
        </span>
      ))}
    </p>
  );
}
