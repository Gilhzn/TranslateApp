"use client";

import * as React from "react";
import { Badge, Button, Progress, cn } from "@/components/ui";
import { getLocaleProfile } from "@/lib/layout";
import { PHASE_LABEL, formatDuration, localeTracks, type RunState } from "./machine";

/**
 * What the job is actually doing, while it does it.
 *
 * Every number on this panel comes off a `JobProgress` frame the route emitted;
 * nothing is interpolated, estimated or animated forward to look busy. Until
 * the first frame lands the bar is explicitly indeterminate rather than sitting
 * at a made-up 5%.
 */

export interface RunMonitorProps {
  run: RunState;
  onCancel: () => void;
  /** False once the stream has settled — freezes the clock at its final value. */
  live?: boolean;
  className?: string;
}

export function RunMonitor({ run, onCancel, live = true, className }: RunMonitorProps) {
  const elapsed = useElapsed(run.startedAt, live);
  const tracks = localeTracks(run);
  const progress = run.progress;

  const phase = progress?.phase ?? "queued";
  const completed = progress?.completedUnits ?? 0;
  const total = progress?.totalUnits ?? run.start?.totalUnits ?? 0;
  const ratio = progress?.progress ?? 0;
  const started = progress !== null;
  const doneCount = tracks.filter((track) => track.state === "done").length;

  return (
    <section
      aria-label="Translation run"
      // Reflected into the DOM so the browser test can prove the phase actually
      // advanced through real `JobPhase` values instead of sitting on one.
      data-phase={phase}
      data-locales-done={doneCount}
      className={cn("surface-card animate-in-rise overflow-hidden", className)}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--border-subtle)] px-5 py-4">
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
          {live && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-accent-500)] opacity-70" />
          )}
          <span
            className={cn(
              "relative inline-flex h-2 w-2 rounded-full",
              live ? "bg-[var(--color-accent-400)]" : "bg-[var(--text-tertiary)]",
            )}
          />
        </span>

        <code className="font-[family-name:var(--font-mono)] text-[13px] text-[var(--text-primary)]">
          {run.request.catalog.fileName}
        </code>
        <Badge tone={phase === "error" ? "danger" : "accent"}>{PHASE_LABEL[phase]}</Badge>
        <span className="text-[12px] text-[var(--text-tertiary)]">
          {run.request.settings.sourceLocale} →{" "}
          <span className="tabular">{tracks.length}</span>{" "}
          {tracks.length === 1 ? "language" : "languages"}
        </span>

        <span className="ml-auto flex items-center gap-3">
          <span className="tabular font-[family-name:var(--font-mono)] text-[12px] text-[var(--text-tertiary)]">
            {formatDuration(elapsed)}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={onCancel}
            disabled={!live}
            className="text-[var(--color-danger-400)] hover:bg-[color-mix(in_oklch,var(--color-danger-500)_14%,transparent)] hover:text-[var(--color-danger-400)]"
          >
            Cancel
          </Button>
        </span>
      </header>

      <div className="space-y-3 px-5 py-4">
        <div className="flex items-baseline justify-between gap-4">
          <p className="tabular text-[22px] font-semibold leading-none tracking-[-0.01em] text-[var(--text-primary)]">
            {started ? `${Math.floor(ratio * 100)}%` : "—"}
          </p>
          <p className="tabular font-[family-name:var(--font-mono)] text-[12px] text-[var(--text-tertiary)]">
            {completed.toLocaleString()} / {total.toLocaleString()} units ·{" "}
            {doneCount}/{tracks.length} locales
          </p>
        </div>

        <Progress
          value={ratio}
          indeterminate={!started}
          label="Overall job completion"
        />

        {/*
          The one line that changes most often. Polite rather than assertive:
          a queue of a hundred "translating batch 4/9" interruptions is worse
          for a screen-reader user than none.
        */}
        <p
          role="status"
          aria-live="polite"
          className="min-h-[1.25rem] text-[12px] leading-relaxed text-[var(--text-secondary)]"
        >
          {progress?.message ?? "Opening the stream…"}
        </p>
      </div>

      <ul
        aria-label="Per-language progress"
        className="grid gap-px border-t border-[var(--border-subtle)] bg-[var(--border-subtle)] sm:grid-cols-2"
      >
        {tracks.map((track) => {
          const profile = getLocaleProfile(track.locale);
          const result = track.result;
          return (
            <li
              key={track.locale}
              data-locale={track.locale}
              data-state={track.state}
              className="flex items-center gap-3 bg-[var(--surface-1)] px-5 py-2.5"
            >
              <TrackGlyph state={track.state} />
              <span className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--text-secondary)]">
                {track.locale}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-tertiary)]">
                {profile.nativeName}
              </span>

              {result !== null ? (
                <span className="flex items-center gap-2 text-[11px]">
                  <span className="tabular text-[var(--color-ok-400)]">
                    {result.stats.passed.toLocaleString()} passed
                  </span>
                  {result.stats.overflowRepaired > 0 && (
                    <span
                      className="tabular text-[var(--color-accent-400)]"
                      title="Translations that overflowed their layout budget and were sent back to the model until they fit"
                    >
                      {result.stats.overflowRepaired} refit
                    </span>
                  )}
                  {result.stats.failed > 0 && (
                    <span className="tabular text-[var(--color-danger-400)]">
                      {result.stats.failed} failed
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-[11px] text-[var(--text-tertiary)]">
                  {track.state === "active" ? "in flight" : "queued"}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TrackGlyph({ state }: { state: "queued" | "active" | "done" }) {
  if (state === "done") {
    return (
      <svg
        viewBox="0 0 14 14"
        className="h-3.5 w-3.5 shrink-0 text-[var(--color-ok-400)]"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="m2.5 7.3 3 3 6-6.6"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (state === "active") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "h-3.5 w-3.5 shrink-0 rounded-full border-2 border-[var(--color-accent-500)]",
          "border-t-transparent motion-safe:animate-spin",
        )}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="h-3.5 w-3.5 shrink-0 rounded-full border border-dashed border-[var(--border-strong)]"
    />
  );
}

/** Wall-clock elapsed time, ticking only while the run is live. */
function useElapsed(startedAt: number, live: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [live, startedAt]);

  return Math.max(0, now - startedAt);
}
