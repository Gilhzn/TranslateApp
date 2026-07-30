"use client";

import * as React from "react";
import { Button, cn } from "@/components/ui";
import type { EntryStatus, IssueCode, LocaleCode } from "@/lib/types";
import { STATUS_LABEL } from "./StatusBadge";
import { TERMINAL_STATUSES } from "./rows";
import {
  isFilterActive,
  issueCodeOptions,
  type ReviewCounts,
  type ReviewFilter,
} from "./filtering";

/**
 * Filter and export bar.
 *
 * Every control shows the number of rows it would reveal, computed against the
 * rest of the filter — so the developer never clicks into an empty table.
 */

export interface LocaleOption {
  code: LocaleCode;
  /** Native name, e.g. "Deutsch". */
  label: string;
  direction: "ltr" | "rtl";
}

export interface ReviewToolbarProps {
  filter: ReviewFilter;
  onFilterChange: (next: ReviewFilter) => void;
  counts: ReviewCounts;
  locales: readonly LocaleOption[];
  /** Download the currently selected locale. Absent when none is selected. */
  onExportLocale: () => void;
  onExportAll: () => void;
  exporting?: boolean;
  searchRef?: React.RefObject<HTMLInputElement | null>;
  className?: string;
}

export function ReviewToolbar({
  filter,
  onFilterChange,
  counts,
  locales,
  onExportLocale,
  onExportAll,
  exporting = false,
  searchRef,
  className,
}: ReviewToolbarProps) {
  const patch = (next: Partial<ReviewFilter>) => {
    onFilterChange({ ...filter, ...next });
  };

  const issueOptions = React.useMemo(() => issueCodeOptions(counts), [counts]);
  const singleLocale = filter.locale !== "all";

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ChipGroup label="Locale">
          <Chip
            selected={filter.locale === "all"}
            count={counts.total}
            onClick={() => {
              patch({ locale: "all" });
            }}
          >
            All locales
          </Chip>
          {locales.map((locale) => (
            <Chip
              key={locale.code}
              selected={filter.locale === locale.code}
              count={counts.byLocale.get(locale.code) ?? 0}
              onClick={() => {
                patch({ locale: locale.code });
              }}
            >
              <span className="font-[family-name:var(--font-mono)] text-[11px] uppercase">
                {locale.code}
              </span>
              <span className="text-[var(--text-tertiary)]">{locale.label}</span>
            </Chip>
          ))}
        </ChipGroup>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={!singleLocale || exporting}
            title={
              singleLocale
                ? undefined
                : "Select a single locale to download one file"
            }
            onClick={onExportLocale}
            iconLeft={<DownloadGlyph />}
          >
            {singleLocale ? `Export ${filter.locale}.json` : "Export locale"}
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={exporting}
            onClick={onExportAll}
            iconLeft={<ArchiveGlyph />}
          >
            {/*
              A partial run can leave exactly one finished locale, and
              "1 locales" is the kind of detail that makes a tool feel unfinished.
            */}
            Export all · {locales.length} {locales.length === 1 ? "locale" : "locales"}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchBox
          value={filter.query}
          inputRef={searchRef}
          onChange={(query) => {
            patch({ query });
          }}
        />

        <ChipGroup label="Status">
          <Chip
            selected={filter.status === "all"}
            onClick={() => {
              patch({ status: "all" });
            }}
          >
            Any status
          </Chip>
          {TERMINAL_STATUSES.map((status) => (
            <Chip
              key={status}
              selected={filter.status === status}
              count={counts.byStatus.get(status) ?? 0}
              tone={statusChipTone(status)}
              onClick={() => {
                patch({ status });
              }}
            >
              {STATUS_LABEL[status]}
            </Chip>
          ))}
        </ChipGroup>

        <label className="flex items-center gap-1.5">
          <span className="sr-only">Filter by issue</span>
          <select
            value={filter.issueCode}
            onChange={(event) => {
              patch({ issueCode: event.target.value as IssueCode | "all" });
            }}
            className={cn(
              "h-8 rounded-[var(--radius-sm)] border border-[var(--border-subtle)]",
              "bg-[var(--surface-2)] px-2 pr-6 text-[13px] text-[var(--text-secondary)]",
              "hover:border-[var(--border-strong)]",
            )}
          >
            <option value="all">Any issue</option>
            {issueOptions.map((option) => (
              <option key={option.code} value={option.code}>
                {option.code} ({option.count})
              </option>
            ))}
          </select>
        </label>

        <Chip
          selected={filter.editedOnly}
          count={counts.edited}
          tone="accent"
          onClick={() => {
            patch({ editedOnly: !filter.editedOnly });
          }}
        >
          Edited by me
        </Chip>

        {isFilterActive(filter) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onFilterChange({
                locale: "all",
                status: "all",
                issueCode: "all",
                query: "",
                editedOnly: false,
              });
            }}
          >
            Clear filters
          </Button>
        )}

        <span
          aria-live="polite"
          className="tabular ml-auto text-[12px] text-[var(--text-tertiary)]"
        >
          {counts.visible.toLocaleString()} of {counts.total.toLocaleString()} strings
          {counts.overflow > 0 && (
            <>
              {" · "}
              <span className="text-[var(--color-danger-400)]">
                {counts.overflow} still overflowing
              </span>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

function statusChipTone(status: EntryStatus): ChipTone {
  if (status === "passed") return "ok";
  if (status === "flagged") return "warn";
  if (status === "failed") return "danger";
  return "neutral";
}

type ChipTone = "neutral" | "ok" | "warn" | "danger" | "accent";

const SELECTED_TONE: Record<ChipTone, string> = {
  neutral:
    "border-[var(--border-strong)] bg-[var(--surface-3)] text-[var(--text-primary)]",
  ok: "border-[color-mix(in_oklch,var(--color-ok-500)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-ok-500)_16%,transparent)] text-[var(--color-ok-400)]",
  warn: "border-[color-mix(in_oklch,var(--color-warn-500)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-warn-500)_16%,transparent)] text-[var(--color-warn-400)]",
  danger:
    "border-[color-mix(in_oklch,var(--color-danger-500)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-danger-500)_16%,transparent)] text-[var(--color-danger-400)]",
  accent:
    "border-[color-mix(in_oklch,var(--color-accent-500)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-accent-500)_16%,transparent)] text-[var(--color-accent-400)]",
};

function ChipGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "flex flex-wrap items-center gap-1 rounded-[var(--radius-md)]",
        "border border-[var(--border-subtle)] bg-[var(--surface-1)] p-1",
      )}
    >
      {children}
    </div>
  );
}

function Chip({
  selected,
  count,
  tone = "neutral",
  onClick,
  children,
}: {
  selected: boolean;
  count?: number;
  tone?: ChipTone;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-sm)] border px-2",
        "text-[12px] font-medium transition-colors",
        selected
          ? SELECTED_TONE[tone]
          : cn(
              "border-transparent text-[var(--text-secondary)]",
              "hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]",
            ),
      )}
    >
      {children}
      {count !== undefined && (
        <span
          className={cn(
            "tabular rounded-full px-1.5 text-[11px] leading-4",
            selected
              ? "bg-[color-mix(in_oklch,var(--color-ink-950)_35%,transparent)]"
              : "bg-[var(--surface-3)] text-[var(--text-tertiary)]",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function SearchBox({
  value,
  onChange,
  inputRef,
}: {
  value: string;
  onChange: (next: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="relative">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
      >
        <svg viewBox="0 0 14 14" width={13} height={13} focusable="false">
          <circle
            cx="6"
            cy="6"
            r="4.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <path
            d="m9.2 9.2 3 3"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <input
        ref={inputRef}
        type="search"
        value={value}
        placeholder="Search keys, source, translations…"
        aria-label="Search keys, source text and translations"
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={cn(
          "h-8 w-[264px] rounded-[var(--radius-sm)] border border-[var(--border-subtle)]",
          "bg-[var(--surface-2)] pl-8 pr-2 text-[13px] text-[var(--text-primary)]",
          "placeholder:text-[var(--text-tertiary)]",
          "hover:border-[var(--border-strong)] focus-visible:border-[var(--color-accent-500)]",
        )}
      />
    </div>
  );
}

function DownloadGlyph() {
  return (
    <svg viewBox="0 0 14 14" width={13} height={13} aria-hidden="true" focusable="false">
      <path
        d="M7 1.8v7M4.2 6.2 7 9l2.8-2.8M2 11.4h10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ArchiveGlyph() {
  return (
    <svg viewBox="0 0 14 14" width={13} height={13} aria-hidden="true" focusable="false">
      <rect
        x="1.6"
        y="3"
        width="10.8"
        height="8.4"
        rx="1.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M1.6 5.6h10.8M7 5.6v2.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
