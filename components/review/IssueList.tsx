"use client";

import * as React from "react";
import { Badge, cn } from "@/components/ui";
import type { Issue, IssueSeverity } from "@/lib/types";

/**
 * The issue list shown inside an expanded row.
 *
 * Severity is carried by three things at once — an outline glyph, a word, and a
 * colour — because an error and a warning must be distinguishable at a glance
 * and without relying on hue.
 */

export type SeverityTone = "danger" | "warn" | "neutral";

export function severityTone(severity: IssueSeverity): SeverityTone {
  if (severity === "error") return "danger";
  if (severity === "warning") return "warn";
  return "neutral";
}

const RAIL: Record<SeverityTone, string> = {
  danger: "var(--color-danger-500)",
  warn: "var(--color-warn-500)",
  neutral: "var(--color-ink-600)",
};

const LABEL: Record<IssueSeverity, string> = {
  error: "Error",
  warning: "Warning",
  info: "Info",
};

export interface IssueListProps {
  issues: readonly Issue[];
  /** Shown when the list is empty. */
  emptyLabel?: string;
  className?: string;
}

export function IssueList({
  issues,
  emptyLabel = "No issues — this string passed every check.",
  className,
}: IssueListProps) {
  if (issues.length === 0) {
    return (
      <p
        className={cn(
          "flex items-center gap-2 text-[13px] text-[var(--text-tertiary)]",
          className,
        )}
      >
        <CheckGlyph />
        {emptyLabel}
      </p>
    );
  }

  return (
    <ul className={cn("flex flex-col gap-1.5", className)}>
      {issues.map((issue, index) => (
        <IssueRow key={`${issue.code}-${index}`} issue={issue} />
      ))}
    </ul>
  );
}

function IssueRow({ issue }: { issue: Issue }) {
  const tone = severityTone(issue.severity);
  const details = readableDetails(issue);

  return (
    <li
      className={cn(
        "rounded-[var(--radius-sm)] border border-[var(--border-subtle)]",
        "bg-[color-mix(in_oklch,var(--surface-3)_55%,transparent)]",
        "px-2.5 py-2 pl-3",
      )}
      style={{ borderLeft: `2px solid ${RAIL[tone]}` }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <SeverityGlyph severity={issue.severity} />
        <span
          className="text-[11px] font-semibold uppercase tracking-wide"
          style={{ color: RAIL[tone] }}
        >
          {LABEL[issue.severity]}
        </span>
        <Badge mono tone="neutral">
          {issue.code}
        </Badge>
      </div>

      <p className="mt-1.5 text-[13px] leading-snug text-[var(--text-secondary)]">
        {issue.message}
      </p>

      {details.length > 0 && (
        <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {details.map(([key, value]) => (
            <div key={key} className="flex items-baseline gap-1.5">
              <dt className="text-[11px] uppercase tracking-wide text-[var(--text-tertiary)]">
                {key}
              </dt>
              <dd className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)]">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

/** `detail` is machine-readable; make it readable without dumping JSON. */
function readableDetails(issue: Issue): Array<[string, string]> {
  if (issue.detail === undefined) return [];
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(issue.detail)) {
    if (value === null) continue;
    const label = key
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .toLowerCase();
    out.push([label, typeof value === "number" ? String(value) : String(value)]);
  }
  return out.slice(0, 6);
}

function SeverityGlyph({ severity }: { severity: IssueSeverity }) {
  const tone = severityTone(severity);
  const color = RAIL[tone];

  return (
    <svg
      viewBox="0 0 12 12"
      width={12}
      height={12}
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      {severity === "error" && (
        <>
          <rect
            x="1"
            y="1"
            width="10"
            height="10"
            rx="2"
            fill="none"
            stroke={color}
            strokeWidth="1.25"
          />
          <path
            d="M4.2 4.2 7.8 7.8M7.8 4.2 4.2 7.8"
            stroke={color}
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </>
      )}
      {severity === "warning" && (
        <>
          <path
            d="M6 1.1 11.2 10.6H0.8Z"
            fill="none"
            stroke={color}
            strokeWidth="1.25"
            strokeLinejoin="round"
          />
          <path d="M6 4.6v2.6" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="6" cy="8.9" r="0.7" fill={color} />
        </>
      )}
      {severity === "info" && (
        <>
          <circle cx="6" cy="6" r="5" fill="none" stroke={color} strokeWidth="1.25" />
          <path d="M6 5.4v3" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="6" cy="3.6" r="0.7" fill={color} />
        </>
      )}
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      width={12}
      height={12}
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <circle
        cx="6"
        cy="6"
        r="5"
        fill="none"
        stroke="var(--color-ok-500)"
        strokeWidth="1.25"
      />
      <path
        d="M3.6 6.2 5.2 7.8 8.4 4.4"
        fill="none"
        stroke="var(--color-ok-500)"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
