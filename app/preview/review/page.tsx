"use client";

import * as React from "react";
import { Badge } from "@/components/ui";
import { ReviewPanel } from "@/components/review";
import { buildDemoJob, summarizeJob } from "@/components/review/demo-data";

/**
 * Standalone preview of the review surface.
 *
 * Exists so the table can be screenshotted and critiqued without running a
 * translation job. The data is produced by `buildDemoJob`, which runs the real
 * parse → budget → translate → validate → repair pipeline over a realistic
 * `en.json`, so what is on screen is the product's actual output shape: ~700
 * rows across six locales, including CJK, RTL, placeholder-heavy strings,
 * genuine overflow failures and repaired entries.
 */
export default function ReviewPreviewPage() {
  const job = React.useMemo(() => buildDemoJob(), []);
  const summary = React.useMemo(() => summarizeJob(job.results), [job.results]);

  return (
    <main className="min-h-dvh bg-[var(--surface-0)]">
      {/*
        The grid backdrop is a sibling layer, not a wrapper: `.grid-backdrop`
        carries a radial `mask-image`, and a mask applies to an element's
        children as well as itself — wrapping the header in it erases the text.
      */}
      <div className="relative border-b border-[var(--border-subtle)]">
        <div
          aria-hidden="true"
          className="grid-backdrop pointer-events-none absolute inset-0"
        />
        <div className="relative mx-auto w-full max-w-[1400px] px-6 py-10">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium tracking-tight text-[var(--text-tertiary)]">
                  LingoLoop
                </span>
                <Badge tone="accent">Preview route</Badge>
              </div>
              <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-[-0.02em] text-gradient">
                Translation review
              </h1>
              <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-[var(--text-secondary)]">
                Every string the agent produced, measured against the space it has
                to live in. Expand a row for the model&apos;s reasoning, the issue
                trail and the placeholder inventory; edit a translation in place
                and the layout verdict updates as you type.
              </p>
            </div>

            <dl className="flex items-center gap-6">
              <PreviewStat label="Strings" value={summary.total} />
              <PreviewStat label="Locales" value={job.results.length} />
              <PreviewStat label="Failed" value={summary.failed} tone="danger" />
            </dl>
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-[1400px] px-6 py-8">
        <ReviewPanel
          catalog={job.catalog}
          results={job.results}
          sourceLocale={job.settings.sourceLocale}
          glossary={job.settings.glossary}
          exportDirectory="public/locales"
          tableHeight={620}
        />
      </div>
    </main>
  );
}

function PreviewStat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "danger";
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
        {label}
      </dt>
      <dd
        className="tabular text-[22px] font-semibold leading-none"
        style={{
          color:
            tone === "danger" && value > 0
              ? "var(--color-danger-400)"
              : "var(--text-primary)",
        }}
      >
        {value.toLocaleString()}
      </dd>
    </div>
  );
}
