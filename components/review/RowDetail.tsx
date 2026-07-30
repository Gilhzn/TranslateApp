"use client";

import * as React from "react";
import { Badge, cn } from "@/components/ui";
import type { Placeholder } from "@/lib/types";
import { FitMeter } from "./FitMeter";
import { IssueList } from "./IssueList";
import { diffPlaceholders, type ReviewRow } from "./rows";
import {
  budgetRationaleForRow,
  repairFeedbackForRow,
  type RecomputeContext,
} from "./recompute";
import { DETAIL_HEIGHT } from "./windowing";

/**
 * Everything the pipeline knew about one string, revealed under its row:
 * the model's rationale, every issue, the placeholder inventory of source
 * against target, the layout budget that was applied, and — when the entry
 * still warrants one — the exact instruction a repair pass would send.
 */

export interface RowDetailProps {
  row: ReviewRow;
  ctx: RecomputeContext;
  /** Direction of the target script, for the RTL columns. */
  direction: "ltr" | "rtl";
  className?: string;
}

export function RowDetail({ row, ctx, direction, className }: RowDetailProps) {
  const placeholders = React.useMemo(
    () => diffPlaceholders(row.sourcePlaceholders, row.targetPlaceholders),
    [row.sourcePlaceholders, row.targetPlaceholders],
  );
  const repairFeedback = React.useMemo(
    () => repairFeedbackForRow(row, ctx),
    [row, ctx],
  );
  const budgetRationale = React.useMemo(
    () => budgetRationaleForRow(row, ctx),
    [row, ctx],
  );

  return (
    <div
      className={cn(
        "overflow-y-auto border-t border-[var(--border-subtle)]",
        "bg-[color-mix(in_oklch,var(--surface-1)_75%,transparent)]",
        "px-4 py-3.5",
        className,
      )}
      style={{ height: DETAIL_HEIGHT }}
    >
      <div className="grid gap-x-8 gap-y-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section className="flex min-w-0 flex-col gap-3">
          {/*
            The table truncates all three of these to keep rows dense; this is
            where the untruncated values live, reachable by keyboard.
          */}
          <Section title="String">
            <dl className="flex flex-col gap-1.5">
              <FullValue label="Key" mono>
                {row.key}
              </FullValue>
              <FullValue label="Source">{row.source}</FullValue>
              <FullValue label="Translation" direction={direction} lang={row.locale}>
                {row.target.length === 0 ? "(empty)" : row.target}
              </FullValue>
            </dl>
          </Section>

          <Section title="Model rationale">
            {row.rationale === undefined || row.rationale.length === 0 ? (
              <p className="text-[13px] text-[var(--text-tertiary)]">
                The provider returned no rationale for this string.
              </p>
            ) : (
              <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
                {row.rationale}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge tone="neutral">{row.role}</Badge>
              <Badge tone={row.attempts > 1 ? "accent" : "neutral"}>
                {row.attempts === 1
                  ? "1 model call"
                  : `${row.attempts} model calls`}
              </Badge>
              {row.doNotTranslate && <Badge tone="neutral">do not translate</Badge>}
              {row.edited && <Badge tone="accent">edited by you</Badge>}
              {row.ambiguities.map((flag) => (
                <Badge key={flag.kind} tone="warn" title={flag.note}>
                  {flag.kind}
                </Badge>
              ))}
            </div>
          </Section>

          {row.developerNote !== undefined && (
            <Section title="Developer note">
              <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
                {row.developerNote}
              </p>
            </Section>
          )}

          <Section title={`Issues (${row.issues.length})`}>
            <IssueList issues={row.issues} />
          </Section>
        </section>

        <section className="flex min-w-0 flex-col gap-3">
          <Section title="Layout budget">
            <FitMeter fit={row.fit} variant="detail" />
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-tertiary)]">
              {budgetRationale}
            </p>
          </Section>

          <Section title="Placeholders">
            <PlaceholderInventory
              source={row.sourcePlaceholders}
              target={row.targetPlaceholders}
              missing={placeholders.missing}
              added={placeholders.added}
              direction={direction}
            />
          </Section>

          {row.neighbors.length > 0 && (
            <Section title="Sibling keys sent as context">
              <div className="flex flex-wrap gap-1">
                {row.neighbors.map((key) => (
                  <code
                    key={key}
                    className="rounded-[var(--radius-xs)] bg-[var(--surface-3)] px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]"
                  >
                    {key}
                  </code>
                ))}
              </div>
            </Section>
          )}

          {repairFeedback !== null && (
            <Section title="Repair instruction for the next pass">
              <pre className="overflow-x-auto whitespace-pre-wrap rounded-[var(--radius-sm)] border border-[color-mix(in_oklch,var(--color-warn-500)_28%,transparent)] bg-[color-mix(in_oklch,var(--color-warn-500)_8%,transparent)] p-2.5 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed text-[var(--text-secondary)]">
                {repairFeedback}
              </pre>
            </Section>
          )}
        </section>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
        {title}
      </h4>
      {children}
    </div>
  );
}

function FullValue({
  label,
  children,
  mono = false,
  direction,
  lang,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
  direction?: "ltr" | "rtl";
  lang?: string;
}) {
  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)] items-baseline gap-2">
      <dt className="text-[11px] uppercase tracking-wide text-[var(--text-tertiary)]">
        {label}
      </dt>
      <dd
        dir={direction}
        lang={lang}
        className={cn(
          "min-w-0 break-words text-[13px] leading-snug text-[var(--text-secondary)]",
          mono && "font-[family-name:var(--font-mono)] text-[12px]",
        )}
      >
        {children}
      </dd>
    </div>
  );
}

export interface PlaceholderInventoryProps {
  source: readonly Placeholder[];
  target: readonly Placeholder[];
  missing: readonly Placeholder[];
  added: readonly Placeholder[];
  direction: "ltr" | "rtl";
}

/**
 * Source and target inventories side by side.
 *
 * Missing and invented placeholders are marked on the side they are wrong on,
 * so the eye lands on the difference rather than on two lists to compare.
 */
export function PlaceholderInventory({
  source,
  target,
  missing,
  added,
  direction,
}: PlaceholderInventoryProps) {
  if (source.length === 0 && target.length === 0) {
    return (
      <p className="text-[13px] text-[var(--text-tertiary)]">
        This string has no placeholders.
      </p>
    );
  }

  const missingSet = new Set(missing.map((p) => `${p.index}:${p.raw}`));
  const addedSet = new Set(added.map((p) => `${p.index}:${p.raw}`));

  return (
    <div className="grid grid-cols-2 gap-3">
      <PlaceholderColumn
        label="Source"
        placeholders={source}
        flagged={missingSet}
        flagTone="danger"
        flagLabel="dropped"
      />
      <PlaceholderColumn
        label="Translation"
        placeholders={target}
        flagged={addedSet}
        flagTone="warn"
        flagLabel="invented"
        direction={direction}
      />
    </div>
  );
}

function PlaceholderColumn({
  label,
  placeholders,
  flagged,
  flagTone,
  flagLabel,
  direction = "ltr",
}: {
  label: string;
  placeholders: readonly Placeholder[];
  flagged: ReadonlySet<string>;
  flagTone: "danger" | "warn";
  flagLabel: string;
  direction?: "ltr" | "rtl";
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px] text-[var(--text-tertiary)]">{label}</div>
      {placeholders.length === 0 ? (
        <div className="text-[13px] text-[var(--text-tertiary)]">none</div>
      ) : (
        <ul className="flex flex-col gap-1" dir={direction}>
          {placeholders.map((placeholder, index) => {
            const isFlagged = flagged.has(`${placeholder.index}:${placeholder.raw}`);
            return (
              <li
                key={`${placeholder.raw}-${placeholder.index}-${index}`}
                className="flex min-w-0 items-center gap-1.5"
                dir="ltr"
              >
                <code
                  className={cn(
                    "truncate rounded-[var(--radius-xs)] border px-1.5 py-0.5",
                    "font-[family-name:var(--font-mono)] text-[11px]",
                    isFlagged
                      ? flagTone === "danger"
                        ? "border-[color-mix(in_oklch,var(--color-danger-500)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-danger-500)_14%,transparent)] text-[var(--color-danger-400)]"
                        : "border-[color-mix(in_oklch,var(--color-warn-500)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-warn-500)_14%,transparent)] text-[var(--color-warn-400)]"
                      : "border-[var(--border-subtle)] bg-[var(--surface-3)] text-[var(--text-secondary)]",
                  )}
                  title={`${placeholder.kind} · token ${placeholder.token}`}
                >
                  {placeholder.raw}
                </code>
                {isFlagged && (
                  <span
                    className={cn(
                      "shrink-0 text-[10px] uppercase tracking-wide",
                      flagTone === "danger"
                        ? "text-[var(--color-danger-400)]"
                        : "text-[var(--color-warn-400)]",
                    )}
                  >
                    {flagLabel}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
