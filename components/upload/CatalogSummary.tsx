"use client";

import * as React from "react";
import type { StringEntry } from "@/lib/types";
import type { ParsedCatalog } from "@/lib/core";
import { Badge, cn } from "@/components/ui";
import {
  AMBIGUITY_META,
  ROLE_LABELS,
  catalogHeadlines,
  describeFormatting,
  groupAmbiguities,
  pickSamples,
  segmentPlaceholders,
  tallyRoles,
  totalAmbiguities,
  type AmbiguityGroup,
  type RoleTally,
} from "./catalog-insights";

/**
 * "Here is what we understood."
 *
 * Shown before anything is translated, because the ambiguity detection is the
 * product's actual intelligence and a developer has no reason to trust it until
 * they have seen it name the exact words they were worried about.
 */

export interface CatalogSummaryProps {
  catalog: ParsedCatalog;
  className?: string;
  /**
   * The flow lands the developer on this panel after a parse: it scrolls the
   * section into view and moves focus to the heading, so keyboard and
   * screen-reader users arrive at the analysis too rather than being left
   * wherever the previous view happened to be.
   */
  headingRef?: React.Ref<HTMLHeadingElement>;
}

const ROLE_SWATCHES: readonly string[] = [
  "var(--color-accent-500)",
  "var(--color-accent-400)",
  "var(--color-ok-500)",
  "var(--color-warn-500)",
  "var(--color-ink-400)",
  "var(--color-accent-700)",
  "var(--color-ok-400)",
  "var(--color-warn-400)",
  "var(--color-ink-600)",
  "var(--color-danger-400)",
  "var(--color-ink-500)",
  "var(--color-ink-700)",
];

function swatch(index: number): string {
  return ROLE_SWATCHES[index % ROLE_SWATCHES.length] ?? "var(--color-ink-500)";
}

export function CatalogSummary({ catalog, className, headingRef }: CatalogSummaryProps) {
  const headlines = React.useMemo(() => catalogHeadlines(catalog), [catalog]);
  const roles = React.useMemo(() => tallyRoles(catalog.entries), [catalog]);
  const groups = React.useMemo(() => groupAmbiguities(catalog.entries), [catalog]);
  const samples = React.useMemo(() => pickSamples(catalog.entries, 5), [catalog]);
  const ambiguityCount = totalAmbiguities(groups);

  return (
    <section
      className={cn("surface-card animate-in-rise overflow-hidden", className)}
      aria-label="Parsed catalog summary"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--border-subtle)] px-5 py-4">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className={cn(
            "text-[13px] font-medium tracking-tight text-[var(--text-primary)]",
            "rounded-[var(--radius-xs)] outline-none",
            "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--color-accent-500)]",
          )}
        >
          What we understood
        </h2>
        <Badge tone="neutral" mono>
          {catalog.fileName}
        </Badge>
        <Badge tone="accent" mono>
          source {catalog.sourceLocale}
        </Badge>
        <span className="ml-auto text-[12px] text-[var(--text-tertiary)]">
          {describeFormatting(catalog)}
        </span>
      </header>

      <div className="grid grid-cols-2 divide-x divide-y divide-[var(--border-subtle)] border-b border-[var(--border-subtle)] sm:grid-cols-3 lg:grid-cols-6 lg:divide-y-0">
        {headlines.map((item) => (
          <div key={item.label} className="px-5 py-4" title={item.hint}>
            <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
              {item.label}
            </p>
            <p className="tabular mt-1.5 text-[22px] font-medium leading-none text-[var(--text-primary)]">
              {item.value}
            </p>
          </div>
        ))}
      </div>

      <RoleStrip roles={roles} />

      <AmbiguityPanel groups={groups} count={ambiguityCount} />

      <SamplePanel samples={samples} />
    </section>
  );
}

// ---------------------------------------------------------------------------

function RoleStrip({ roles }: { roles: readonly RoleTally[] }) {
  if (roles.length === 0) {
    return (
      <div className="border-b border-[var(--border-subtle)] px-5 py-4">
        <SectionTitle>Role distribution</SectionTitle>
        <p className="mt-2 text-[13px] text-[var(--text-tertiary)]">
          No translatable strings to classify.
        </p>
      </div>
    );
  }

  return (
    <div className="border-b border-[var(--border-subtle)] px-5 py-4">
      <SectionTitle
        hint="Roles drive both the length budget and the register — a button is not a heading."
      >
        Role distribution
      </SectionTitle>

      <div
        className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-[var(--surface-3)]"
        role="img"
        aria-label={roles
          .map((tally) => `${ROLE_LABELS[tally.role]}: ${tally.count}`)
          .join(", ")}
      >
        {roles.map((tally, index) => (
          <span
            key={tally.role}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{
              width: `${Math.max(tally.share * 100, 0.8)}%`,
              backgroundColor: swatch(index),
            }}
          />
        ))}
      </div>

      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {roles.map((tally, index) => (
          <li key={tally.role} className="flex items-center gap-2 text-[12px]">
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: swatch(index) }}
            />
            <span className="text-[var(--text-secondary)]">{ROLE_LABELS[tally.role]}</span>
            <span className="tabular text-[var(--text-tertiary)]">{tally.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------

function AmbiguityPanel({
  groups,
  count,
}: {
  groups: readonly AmbiguityGroup[];
  count: number;
}) {
  return (
    <div className="border-b border-[var(--border-subtle)] px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <SectionTitle hint="Words whose English form hides more than one meaning. Each one is resolved by its UI role and sent to the model as an explicit instruction.">
          Detected ambiguities
        </SectionTitle>
        {count > 0 && (
          <Badge tone="warn">
            {count} flag{count === 1 ? "" : "s"} across {groups.length} kind
            {groups.length === 1 ? "" : "s"}
          </Badge>
        )}
      </div>

      {groups.length === 0 ? (
        <p className="mt-3 text-[13px] leading-relaxed text-[var(--text-tertiary)]">
          No ambiguous terms found. Every string in this catalog has a single
          obvious reading, so nothing needs a disambiguation instruction.
        </p>
      ) : (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {groups.map((group) => {
            const meta = AMBIGUITY_META[group.kind];
            return (
              <div
                key={group.kind}
                className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3.5"
              >
                <div className="flex items-baseline gap-2">
                  <h4 className="text-[13px] font-medium text-[var(--text-primary)]">
                    {meta.label}
                  </h4>
                  <span className="tabular text-[12px] text-[var(--text-tertiary)]">
                    {group.count}
                  </span>
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-tertiary)]">
                  {meta.blurb}
                </p>

                <ul className="mt-2.5 space-y-2">
                  {group.items.map((item) => (
                    <li
                      key={`${item.key}:${item.note}`}
                      className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--surface-2)] px-2.5 py-2"
                    >
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <code className="truncate font-[family-name:var(--font-mono)] text-[11px] text-[var(--color-accent-400)]">
                          {item.key}
                        </code>
                        <span className="text-[13px] text-[var(--text-primary)]">
                          “{item.value}”
                        </span>
                        <span className="ml-auto text-[11px] text-[var(--text-tertiary)]">
                          as {ROLE_LABELS[item.role].toLowerCase()}
                        </span>
                      </div>
                      <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                        {item.note}
                      </p>
                    </li>
                  ))}
                </ul>

                {group.overflow > 0 && (
                  <p className="mt-2 text-[12px] text-[var(--text-tertiary)]">
                    +{group.overflow} more of this kind
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SamplePanel({ samples }: { samples: readonly StringEntry[] }) {
  if (samples.length === 0) return null;

  return (
    <div className="px-5 py-4">
      <SectionTitle hint="A cross-section of the file — one per detected role, then the longest strings.">
        Sample entries
      </SectionTitle>

      <ul className="mt-3 divide-y divide-[var(--border-subtle)] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)]">
        {samples.map((entry) => (
          <li
            key={entry.key}
            className="flex flex-wrap items-start gap-x-4 gap-y-1.5 bg-[var(--surface-1)] px-3.5 py-2.5"
          >
            <code className="min-w-0 max-w-[38%] shrink-0 truncate font-[family-name:var(--font-mono)] text-[12px] text-[var(--text-tertiary)]">
              {entry.key}
            </code>
            <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-[var(--text-primary)]">
              {segmentPlaceholders(entry.value, entry.placeholders).map(
                (segment, index) =>
                  segment.placeholder ? (
                    <span
                      key={index}
                      title="Placeholder — reproduced byte-for-byte in every locale"
                      className={cn(
                        "rounded-[3px] px-1 py-px font-[family-name:var(--font-mono)] text-[12px]",
                        "bg-[color-mix(in_oklch,var(--color-accent-500)_20%,transparent)]",
                        "text-[var(--color-accent-400)]",
                      )}
                    >
                      {segment.text}
                    </span>
                  ) : (
                    <React.Fragment key={index}>{segment.text}</React.Fragment>
                  ),
              )}
            </p>
            <div className="flex shrink-0 items-center gap-1.5">
              {entry.placeholders.length > 0 && (
                <Badge tone="accent">
                  {entry.placeholders.length} placeholder
                  {entry.placeholders.length === 1 ? "" : "s"}
                </Badge>
              )}
              <Badge tone="neutral">{ROLE_LABELS[entry.role]}</Badge>
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-2 text-[12px] text-[var(--text-tertiary)]">
        Highlighted tokens are placeholders. They are counted before and after
        translation and must match exactly, or the string is repaired.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SectionTitle({
  children,
  hint,
}: {
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <h3
      className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]"
      title={hint}
    >
      {children}
    </h3>
  );
}
