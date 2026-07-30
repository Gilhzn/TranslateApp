"use client";

import * as React from "react";
import { Badge, Button, cn } from "@/components/ui";
import type { FlowFailure, RunState } from "./machine";
import { localeTracks } from "./machine";

/**
 * The four ways a run stops badly, each with its own way out.
 *
 * A cancel is not an error and is not coloured like one; a 4xx refusal is not
 * retryable and does not offer a retry button that will fail identically; and a
 * run that produced three of five locales before dying says so and lets the
 * developer keep those three, because those three files are finished.
 */

export interface FlowErrorPanelProps {
  failure: FlowFailure;
  run: RunState;
  onRetry: () => void;
  onBackToSetup: () => void;
  onReviewPartial: () => void;
  className?: string;
}

interface FailureTone {
  border: string;
  text: string;
  badge: "warn" | "danger" | "neutral";
  label: string;
}

const TONE: Readonly<Record<FlowFailure["kind"], FailureTone>> = {
  request: {
    border: "border-[color-mix(in_oklch,var(--color-danger-500)_38%,transparent)]",
    text: "text-[var(--color-danger-400)]",
    badge: "danger",
    label: "Refused",
  },
  job: {
    border: "border-[color-mix(in_oklch,var(--color-danger-500)_38%,transparent)]",
    text: "text-[var(--color-danger-400)]",
    badge: "danger",
    label: "Failed",
  },
  network: {
    border: "border-[color-mix(in_oklch,var(--color-warn-500)_38%,transparent)]",
    text: "text-[var(--color-warn-400)]",
    badge: "warn",
    label: "Interrupted",
  },
  cancelled: {
    border: "border-[var(--border-strong)]",
    text: "text-[var(--text-primary)]",
    badge: "neutral",
    label: "Cancelled",
  },
};

export function FlowErrorPanel({
  failure,
  run,
  onRetry,
  onBackToSetup,
  onReviewPartial,
  className,
}: FlowErrorPanelProps) {
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const tracks = localeTracks(run);
  const finished = run.results.length;
  const tone = TONE[failure.kind];

  // The run panel this replaces held focus context; move focus to the heading
  // so a keyboard or screen-reader user lands on the explanation, not at the
  // top of the document.
  React.useEffect(() => {
    headingRef.current?.focus();
  }, [failure]);

  return (
    <section
      role={failure.kind === "cancelled" ? "status" : "alert"}
      aria-live="polite"
      className={cn("surface-card animate-in-rise overflow-hidden", tone.border, className)}
    >
      <div className="space-y-3 px-5 py-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <Badge tone={tone.badge}>{tone.label}</Badge>
          <code className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
            {failure.code}
          </code>
        </div>

        <h2
          ref={headingRef}
          tabIndex={-1}
          className={cn("text-[16px] font-semibold tracking-[-0.01em]", tone.text)}
        >
          {failure.title}
        </h2>

        <p className="max-w-[70ch] text-[13px] leading-relaxed text-[var(--text-secondary)]">
          {failure.message}
        </p>

        {failure.detail.length > 0 && (
          <ul className="space-y-0.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-0)] px-3.5 py-2.5">
            {failure.detail.map((line) => (
              <li
                key={line}
                className="font-[family-name:var(--font-mono)] text-[11.5px] leading-relaxed text-[var(--text-tertiary)]"
              >
                {line}
              </li>
            ))}
          </ul>
        )}

        <p className="max-w-[70ch] text-[13px] leading-relaxed text-[var(--text-tertiary)]">
          {failure.hint}
        </p>

        {finished > 0 && (
          <p className="text-[12px] text-[var(--text-secondary)]">
            <span className="tabular font-medium text-[var(--color-ok-400)]">
              {finished}
            </span>{" "}
            of <span className="tabular">{tracks.length}</span>{" "}
            {tracks.length === 1 ? "language" : "languages"} finished before the run
            stopped:{" "}
            <span className="font-[family-name:var(--font-mono)]">
              {run.results.map((result) => result.locale).join(", ")}
            </span>
            .
          </p>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] px-5 py-3.5">
        {failure.retryable && (
          <Button variant="primary" size="sm" onClick={onRetry}>
            Run again
          </Button>
        )}
        {finished > 0 && (
          <Button variant="secondary" size="sm" onClick={onReviewPartial}>
            Review the {finished} finished {finished === 1 ? "language" : "languages"}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onBackToSetup}>
          Back to setup
        </Button>
      </footer>
    </section>
  );
}
