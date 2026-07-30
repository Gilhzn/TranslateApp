"use client";

import * as React from "react";
import { Button, cn } from "@/components/ui";
import { FitMeter } from "./FitMeter";
import { RowDetail } from "./RowDetail";
import { StatusBadge } from "./StatusBadge";
import { evaluateTarget, type RecomputeContext } from "./recompute";
import type { ReviewRow } from "./rows";
import {
  DETAIL_HEIGHT,
  ROW_HEIGHT,
  buildOffsets,
  computeWindow,
  scrollToIndex,
} from "./windowing";

/**
 * The review table.
 *
 * Three things drive the implementation:
 *
 *   1. **Scale.** Only the visible slice is mounted (see `windowing.ts`). A
 *      3,000-row catalog mounts ~30 rows.
 *   2. **Keyboard.** The table is an ARIA grid: one tab stop, arrow keys move
 *      the active row, `Enter` expands, `E` edits, `Escape` collapses. Active
 *      row identity travels via `aria-activedescendant`, which is the only
 *      model that survives rows being unmounted underneath the user.
 *   3. **Editing is judged live.** The draft is evaluated on every keystroke
 *      through the same `evaluateFit` + validators the pipeline used, so an
 *      edit that overflows turns the meter red as it is typed — and the editor
 *      offers the same trim the exporter would apply.
 */

const HEADER_HEIGHT = 34;
/** Roughly the height of the inline editor popover, used to reserve room. */
const EDITOR_OVERLAY_HEIGHT = 196;

const COLUMNS_WITH_LOCALE =
  "28px minmax(140px,1.05fr) 62px minmax(150px,1.15fr) minmax(190px,1.5fr) 168px 118px";
const COLUMNS_WITHOUT_LOCALE =
  "28px minmax(140px,1.05fr) minmax(150px,1.15fr) minmax(190px,1.5fr) 168px 118px";

export interface ReviewTableProps {
  /** Rows to render — already filtered and ordered by the caller. */
  rows: readonly ReviewRow[];
  /** Recompute context for a locale; memoise it in the caller. */
  contextFor: (locale: string) => RecomputeContext;
  /** Commit an override. */
  onEdit: (row: ReviewRow, nextTarget: string) => void;
  /** Restore the model's own output. */
  onRevert: (row: ReviewRow) => void;
  /** Clip an overflowing translation to its budget. */
  onTrim: (row: ReviewRow) => void;
  showLocale?: boolean;
  /** Height of the scroll viewport in pixels. */
  height?: number;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Shown when `rows` is empty and nothing is loading. */
  emptyTitle?: string;
  emptyHint?: string;
  className?: string;
}

export function ReviewTable({
  rows,
  contextFor,
  onEdit,
  onRevert,
  onTrim,
  showLocale = true,
  height = 560,
  loading = false,
  error = null,
  onRetry,
  emptyTitle = "No strings match these filters",
  emptyHint = "Clear the search box or pick a different status to see the rest of the catalog.",
  className,
}: ReviewTableProps) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const gridRef = React.useRef<HTMLDivElement | null>(null);

  const [scrollTop, setScrollTop] = React.useState(0);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [editing, setEditing] = React.useState<{
    id: string;
    draft: string;
  } | null>(null);

  const columns = showLocale ? COLUMNS_WITH_LOCALE : COLUMNS_WITHOUT_LOCALE;
  const viewportHeight = height - HEADER_HEIGHT;

  const offsets = React.useMemo(
    () =>
      buildOffsets(rows.length, ROW_HEIGHT, DETAIL_HEIGHT, (index) => {
        const row = rows[index];
        return row !== undefined && expanded.has(row.id);
      }),
    [rows, expanded],
  );

  const slice = React.useMemo(
    () => computeWindow(offsets, scrollTop, viewportHeight),
    [offsets, scrollTop, viewportHeight],
  );

  // A filter change can leave the cursor past the end of the list.
  React.useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  const commitDraft = React.useCallback(() => {
    // Deliberately not inside a state updater: updaters must stay pure, and
    // React re-invokes them in development.
    if (editing === null) return;
    const row = rows.find((candidate) => candidate.id === editing.id);
    if (row !== undefined && row.target !== editing.draft) {
      onEdit(row, editing.draft);
    }
    setEditing(null);
  }, [editing, onEdit, rows]);

  const handleScroll = React.useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      setScrollTop(event.currentTarget.scrollTop);
    },
    [],
  );

  /** Move the cursor, scrolling the row into view in the same commit. */
  const moveTo = React.useCallback(
    (nextIndex: number) => {
      const clamped = Math.max(0, Math.min(rows.length - 1, nextIndex));
      setActiveIndex(clamped);

      const container = scrollRef.current;
      if (container === null) return;
      const next = scrollToIndex(
        offsets,
        clamped,
        container.scrollTop,
        viewportHeight,
        HEADER_HEIGHT,
      );
      if (next !== null) {
        container.scrollTop = next;
        // Mirrored into state so the window that renders this frame already
        // contains the row we are about to point `aria-activedescendant` at.
        setScrollTop(next);
      }
    },
    [offsets, rows.length, viewportHeight],
  );

  const toggleExpanded = React.useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const startEditing = React.useCallback((row: ReviewRow) => {
    setEditing({ id: row.id, draft: row.target });
  }, []);

  // Row callbacks are hoisted and stable so the memoised rows actually memoise.
  const handleActivate = React.useCallback((index: number) => {
    setActiveIndex(index);
    gridRef.current?.focus();
  }, []);

  const handleToggleExpanded = React.useCallback(
    (row: ReviewRow) => {
      toggleExpanded(row.id);
    },
    [toggleExpanded],
  );

  const handleStartEditing = React.useCallback(
    (row: ReviewRow, index: number) => {
      setActiveIndex(index);
      startEditing(row);

      // The editor is an overlay hanging below its cell; make room for it so a
      // row near the bottom edge does not open into a clipped popover.
      const container = scrollRef.current;
      if (container === null) return;
      const needed =
        (offsets[index + 1] ?? 0) + EDITOR_OVERLAY_HEIGHT - viewportHeight;
      if (needed > container.scrollTop) {
        container.scrollTop = needed;
        setScrollTop(needed);
      }
    },
    [offsets, startEditing, viewportHeight],
  );

  const handleDraftChange = React.useCallback((value: string) => {
    setEditing((current) => (current === null ? current : { ...current, draft: value }));
  }, []);

  const handleCommit = React.useCallback(() => {
    commitDraft();
    gridRef.current?.focus();
  }, [commitDraft]);

  const handleCancel = React.useCallback(() => {
    setEditing(null);
    gridRef.current?.focus();
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (editing !== null) return; // the editor owns the keyboard while open
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    const row = rows[activeIndex];
    const pageSize = Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT) - 1);

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveTo(activeIndex + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveTo(activeIndex - 1);
        break;
      case "PageDown":
        event.preventDefault();
        moveTo(activeIndex + pageSize);
        break;
      case "PageUp":
        event.preventDefault();
        moveTo(activeIndex - pageSize);
        break;
      case "Home":
        event.preventDefault();
        moveTo(0);
        break;
      case "End":
        event.preventDefault();
        moveTo(rows.length - 1);
        break;
      case "Enter":
      case " ":
        if (row !== undefined) {
          event.preventDefault();
          toggleExpanded(row.id);
        }
        break;
      case "Escape":
        if (row !== undefined && expanded.has(row.id)) {
          event.preventDefault();
          toggleExpanded(row.id);
        }
        break;
      case "e":
      case "E":
      case "F2":
        if (row !== undefined) {
          event.preventDefault();
          startEditing(row);
        }
        break;
      default:
        break;
    }
  };

  if (error !== null) {
    return (
      <Shell className={className} height={height}>
        <ErrorState message={error} onRetry={onRetry} />
      </Shell>
    );
  }

  if (loading) {
    return (
      <Shell className={className} height={height}>
        <SkeletonRows columns={columns} showLocale={showLocale} />
      </Shell>
    );
  }

  const activeRow = rows[activeIndex];
  const activeId = activeRow === undefined ? undefined : `review-row-${activeRow.id}`;

  return (
    <Shell className={className}>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="overflow-auto overscroll-contain"
        style={{ height }}
      >
        {/*
          The grid is the single tab stop; its own outline is suppressed and the
          focus indicator is drawn on the active row instead, which is where the
          keyboard cursor actually is.
        */}
        <div
          ref={gridRef}
          role="grid"
          aria-label="Translation review"
          aria-rowcount={rows.length + 1}
          aria-colcount={showLocale ? 7 : 6}
          aria-activedescendant={activeId}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          className="group/grid relative min-w-[880px] outline-none focus-visible:outline-none"
        >
          <HeaderRow columns={columns} showLocale={showLocale} />

          {rows.length > 0 && (
            <>
              <div role="presentation" style={{ height: slice.padTop }} />
              {Array.from({ length: slice.end - slice.start }, (_, offset) => {
                const index = slice.start + offset;
                const row = rows[index];
                if (row === undefined) return null;
                return (
                  <TableRow
                    key={row.id}
                    row={row}
                    index={index}
                    columns={columns}
                    showLocale={showLocale}
                    active={index === activeIndex}
                    expanded={expanded.has(row.id)}
                    editing={editing !== null && editing.id === row.id}
                    draft={editing !== null && editing.id === row.id ? editing.draft : null}
                    ctx={contextFor(row.locale)}
                    onActivate={handleActivate}
                    onToggleExpanded={handleToggleExpanded}
                    onStartEditing={handleStartEditing}
                    onDraftChange={handleDraftChange}
                    onCommit={handleCommit}
                    onCancel={handleCancel}
                    onRevert={onRevert}
                    onTrim={onTrim}
                  />
                );
              })}
              <div role="presentation" style={{ height: slice.padBottom }} />
            </>
          )}
        </div>

        {/* Outside the grid: a grid's children must be rows. */}
        {rows.length === 0 && <EmptyState title={emptyTitle} hint={emptyHint} />}
      </div>
    </Shell>
  );
}

function Shell({
  children,
  className,
  height,
}: {
  children: React.ReactNode;
  className?: string;
  height?: number;
}) {
  return (
    <div
      className={cn(
        "surface-card overflow-hidden",
        height !== undefined && "grid",
        className,
      )}
      style={height === undefined ? undefined : { height }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function HeaderRow({
  columns,
  showLocale,
}: {
  columns: string;
  showLocale: boolean;
}) {
  return (
    <div
      role="row"
      aria-rowindex={1}
      className={cn(
        "sticky top-0 z-20 grid items-center gap-3 px-3",
        "border-b border-[var(--border-strong)]",
        "bg-[color-mix(in_oklch,var(--surface-1)_92%,transparent)] backdrop-blur-sm",
        "text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]",
      )}
      style={{ gridTemplateColumns: columns, height: HEADER_HEIGHT }}
    >
      <span role="columnheader" aria-label="Expand" />
      <span role="columnheader">Key</span>
      {showLocale && <span role="columnheader">Locale</span>}
      <span role="columnheader">Source</span>
      <span role="columnheader">Translation</span>
      <span role="columnheader">Fit</span>
      <span role="columnheader">Status</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface TableRowProps {
  row: ReviewRow;
  index: number;
  columns: string;
  showLocale: boolean;
  active: boolean;
  expanded: boolean;
  editing: boolean;
  draft: string | null;
  ctx: RecomputeContext;
  onActivate: (index: number) => void;
  onToggleExpanded: (row: ReviewRow) => void;
  onStartEditing: (row: ReviewRow, index: number) => void;
  onDraftChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onRevert: (row: ReviewRow) => void;
  onTrim: (row: ReviewRow) => void;
}

const TableRow = React.memo(function TableRow({
  row,
  index,
  columns,
  showLocale,
  active,
  expanded,
  editing,
  draft,
  ctx,
  onActivate,
  onToggleExpanded,
  onStartEditing,
  onDraftChange,
  onCommit,
  onCancel,
  onRevert,
  onTrim,
}: TableRowProps) {
  const direction = ctx.profile.direction;
  const tabIndex = active ? 0 : -1;

  return (
    <div
      role="rowgroup"
      className={cn(
        "border-b border-[var(--border-subtle)]",
        editing && "relative z-30",
      )}
    >
      <div
        id={`review-row-${row.id}`}
        role="row"
        aria-rowindex={index + 2}
        aria-selected={active}
        aria-expanded={expanded}
        onMouseDown={() => {
          onActivate(index);
        }}
        onDoubleClick={() => {
          onStartEditing(row, index);
        }}
        className={cn(
          "group grid cursor-default items-center gap-3 px-3",
          "text-[13px] leading-none",
          "hover:bg-[color-mix(in_oklch,var(--color-ink-800)_45%,transparent)]",
          active &&
            cn(
              "bg-[color-mix(in_oklch,var(--color-accent-500)_10%,transparent)]",
              "shadow-[inset_2px_0_0_var(--color-accent-500)]",
              "group-focus-visible/grid:ring-1 group-focus-visible/grid:ring-inset",
              "group-focus-visible/grid:ring-[color-mix(in_oklch,var(--color-accent-400)_75%,transparent)]",
            ),
          row.status === "failed" &&
            !active &&
            "shadow-[inset_2px_0_0_color-mix(in_oklch,var(--color-danger-500)_70%,transparent)]",
        )}
        style={{ gridTemplateColumns: columns, height: ROW_HEIGHT }}
      >
        <button
          type="button"
          tabIndex={tabIndex}
          aria-label={expanded ? `Collapse ${row.key}` : `Expand ${row.key}`}
          aria-expanded={expanded}
          onClick={(event) => {
            event.stopPropagation();
            onToggleExpanded(row);
          }}
          className={cn(
            "grid h-5 w-5 place-items-center rounded-[var(--radius-xs)]",
            "text-[var(--text-tertiary)] transition-colors",
            "hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]",
          )}
        >
          <svg
            viewBox="0 0 12 12"
            width={10}
            height={10}
            aria-hidden="true"
            focusable="false"
            className={cn(
              "transition-transform duration-150 motion-reduce:transition-none",
              expanded && "rotate-90",
            )}
          >
            <path
              d="M4 2.5 8 6l-4 3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <code
          title={row.key}
          className="truncate font-[family-name:var(--font-mono)] text-[12px] text-[var(--text-tertiary)] group-hover:text-[var(--text-secondary)]"
        >
          {row.key}
        </code>

        {showLocale && (
          <span className="truncate font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-wide text-[var(--text-tertiary)]">
            {row.locale}
          </span>
        )}

        <span title={row.source} className="truncate text-[var(--text-secondary)]">
          {row.source}
        </span>

        <TranslationCell
          row={row}
          ctx={ctx}
          editing={editing}
          draft={draft}
          direction={direction}
          tabIndex={tabIndex}
          onStartEditing={() => {
            onStartEditing(row, index);
          }}
          onDraftChange={onDraftChange}
          onCommit={onCommit}
          onCancel={onCancel}
          onRevert={() => {
            onRevert(row);
          }}
          onTrim={() => {
            onTrim(row);
          }}
        />

        <FitMeter fit={row.fit} />

        <StatusBadge status={row.status} edited={row.edited} />
      </div>

      {expanded && (
        <div role="row">
          <div role="gridcell" aria-colspan={showLocale ? 7 : 6}>
            <RowDetail row={row} ctx={ctx} direction={direction} />
          </div>
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Inline editing
// ---------------------------------------------------------------------------

interface TranslationCellProps {
  row: ReviewRow;
  ctx: RecomputeContext;
  editing: boolean;
  draft: string | null;
  direction: "ltr" | "rtl";
  tabIndex: number;
  onStartEditing: () => void;
  onDraftChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onRevert: () => void;
  onTrim: () => void;
}

function TranslationCell({
  row,
  ctx,
  editing,
  draft,
  direction,
  tabIndex,
  onStartEditing,
  onDraftChange,
  onCommit,
  onCancel,
  onRevert,
  onTrim,
}: TranslationCellProps) {
  if (editing) {
    return (
      <TranslationEditor
        row={row}
        ctx={ctx}
        draft={draft ?? row.target}
        direction={direction}
        onDraftChange={onDraftChange}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span
        dir={direction}
        lang={row.locale}
        title={row.target}
        className={cn(
          "min-w-0 flex-1 truncate",
          row.target.length === 0
            ? "italic text-[var(--color-danger-400)]"
            : "text-[var(--text-primary)]",
          row.edited && "text-[var(--color-accent-400)]",
        )}
      >
        {row.target.length === 0 ? "empty" : row.target}
      </span>

      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <IconAction
          label={`Edit ${row.key}`}
          tabIndex={tabIndex}
          onClick={onStartEditing}
        >
          <path
            d="M2.5 9.5 3 7.2l5-5 1.8 1.8-5 5z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </IconAction>
        {row.fit?.verdict === "overflow" && (
          <IconAction
            label={`Trim ${row.key} to fit`}
            tabIndex={tabIndex}
            tone="danger"
            onClick={onTrim}
          >
            <path
              d="M2 6h8M8 3.2 10.4 6 8 8.8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </IconAction>
        )}
        {row.edited && (
          <IconAction
            label={`Revert ${row.key} to the model output`}
            tabIndex={tabIndex}
            onClick={onRevert}
          >
            <path
              d="M3.2 6.5A3.3 3.3 0 1 0 4.6 3.6L2.6 5.2M2.4 2.8v2.6h2.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </IconAction>
        )}
      </span>
    </div>
  );
}

function IconAction({
  label,
  onClick,
  tabIndex,
  tone = "neutral",
  children,
}: {
  label: string;
  onClick: () => void;
  tabIndex: number;
  tone?: "neutral" | "danger";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      tabIndex={tabIndex}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "grid h-5 w-5 place-items-center rounded-[var(--radius-xs)]",
        "border border-transparent transition-colors",
        "hover:border-[var(--border-subtle)] hover:bg-[var(--surface-3)]",
        tone === "danger"
          ? "text-[var(--color-danger-400)]"
          : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]",
      )}
    >
      <svg viewBox="0 0 12 12" width={11} height={11} aria-hidden="true" focusable="false">
        {children}
      </svg>
    </button>
  );
}

function TranslationEditor({
  row,
  ctx,
  draft,
  direction,
  onDraftChange,
  onCommit,
  onCancel,
}: {
  row: ReviewRow;
  ctx: RecomputeContext;
  draft: string;
  direction: "ltr" | "rtl";
  onDraftChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);

  React.useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, []);

  // The whole point of the product: the developer's own text is judged by the
  // same engine, on every keystroke.
  const live = React.useMemo(
    () => evaluateTarget(row, draft, ctx),
    [row, draft, ctx],
  );
  const overflowing = live.fit.verdict === "overflow";
  const blocking = live.issues.filter((issue) => issue.severity === "error");

  return (
    <div className="relative min-w-0">
      {/*
        The row focuses the grid on mousedown; inside the editor that would
        steal focus out of the textarea on every click.
      */}
      <div
        ref={panelRef}
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
        }}
        onBlur={(event) => {
          // Clicking a button inside the panel must not count as leaving it.
          const next = event.relatedTarget;
          if (next instanceof Node && panelRef.current?.contains(next)) return;
          onCommit();
        }}
        className={cn(
          "absolute -left-2 -top-1.5 z-40 w-[calc(100%+1rem)] min-w-[280px]",
          "rounded-[var(--radius-md)] border p-2",
          "bg-[var(--surface-2)] shadow-[0_18px_40px_-12px_rgba(0,0,0,0.75)]",
          overflowing
            ? "border-[color-mix(in_oklch,var(--color-danger-500)_65%,transparent)]"
            : "border-[color-mix(in_oklch,var(--color-accent-500)_55%,transparent)]",
        )}
      >
        <textarea
          ref={inputRef}
          value={draft}
          dir={direction}
          lang={row.locale}
          rows={2}
          spellCheck={false}
          aria-label={`Translation for ${row.key}`}
          aria-invalid={overflowing || blocking.length > 0}
          onChange={(event) => {
            onDraftChange(event.target.value);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onCommit();
            }
          }}
          className={cn(
            "w-full resize-none rounded-[var(--radius-sm)] border border-[var(--border-subtle)]",
            "bg-[var(--surface-0)] px-2 py-1.5 text-[13px] leading-snug text-[var(--text-primary)]",
            "outline-none focus-visible:border-[var(--color-accent-500)]",
          )}
        />

        <div className="mt-2 flex items-center gap-3">
          <FitMeter fit={live.fit} className="min-w-0 flex-1" />
          <StatusBadge status={live.status} />
        </div>

        {overflowing && (
          <p className="mt-2 flex items-center gap-1.5 text-[12px] text-[var(--color-danger-400)]">
            <span aria-hidden="true">■</span>
            Overflows by about {live.fit.overBy} character
            {live.fit.overBy === 1 ? "" : "s"} — this will be clipped on export.
          </p>
        )}

        {blocking.slice(0, 2).map((issue, index) => (
          <p
            key={`${issue.code}-${index}`}
            className="mt-1 text-[12px] leading-snug text-[var(--color-danger-400)]"
          >
            {issue.message}
          </p>
        ))}

        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--text-tertiary)]">
            Enter to apply · Esc to cancel
          </span>
          <span className="flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={onCommit}>
              Apply
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <svg
        viewBox="0 0 24 24"
        width={26}
        height={26}
        aria-hidden="true"
        focusable="false"
        className="text-[var(--color-ink-600)]"
      >
        <circle
          cx="10.5"
          cy="10.5"
          r="6.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        <path
          d="m15.5 15.5 4.5 4.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
      <p className="text-[14px] font-medium text-[var(--text-primary)]">{title}</p>
      <p className="max-w-sm text-[13px] leading-relaxed text-[var(--text-tertiary)]">
        {hint}
      </p>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center"
    >
      <svg
        viewBox="0 0 24 24"
        width={26}
        height={26}
        aria-hidden="true"
        focusable="false"
        className="text-[var(--color-danger-400)]"
      >
        <path
          d="M12 3.5 22 20.5H2Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path d="M12 9.5v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="12" cy="17.6" r="1" fill="currentColor" />
      </svg>
      <p className="text-[14px] font-medium text-[var(--text-primary)]">
        The review table could not be built
      </p>
      <p className="max-w-md text-[13px] leading-relaxed text-[var(--text-tertiary)]">
        {message}
      </p>
      {onRetry !== undefined && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

function SkeletonRows({
  columns,
  showLocale,
}: {
  columns: string;
  showLocale: boolean;
}) {
  return (
    <div aria-busy="true" aria-live="polite" className="w-full">
      <HeaderRow columns={columns} showLocale={showLocale} />
      <span className="sr-only">Loading translations…</span>
      {Array.from({ length: 12 }, (_, index) => (
        <div
          key={index}
          className="grid items-center gap-3 border-b border-[var(--border-subtle)] px-3"
          style={{ gridTemplateColumns: columns, height: ROW_HEIGHT }}
        >
          <Bar width="60%" />
          <Bar width={`${55 + ((index * 13) % 35)}%`} />
          {showLocale && <Bar width="50%" />}
          <Bar width={`${45 + ((index * 17) % 45)}%`} />
          <Bar width={`${50 + ((index * 23) % 40)}%`} />
          <Bar width="80%" />
          <Bar width="60%" />
        </div>
      ))}
    </div>
  );
}

function Bar({ width }: { width: string }) {
  return (
    <span
      aria-hidden="true"
      className="shimmer h-2 rounded-full bg-[linear-gradient(90deg,var(--surface-3),var(--color-ink-700),var(--surface-3))]"
      style={{ width }}
    />
  );
}
