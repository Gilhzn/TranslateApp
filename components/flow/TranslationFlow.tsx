"use client";

import * as React from "react";
import { Badge, Button, cn } from "@/components/ui";
import { ReviewPanel } from "@/components/review";
import { ProviderNotice, UploadStage, selectableLocales } from "@/components/upload";
import type { ParsedCatalog } from "@/lib/core";
import type { ActiveProviderDescription } from "@/lib/engine";
import { readSseStream } from "@/lib/pipeline";
import type { TranslationSettings } from "@/lib/types";
import { FlowErrorPanel } from "./FlowErrorPanel";
import { RunMonitor } from "./RunMonitor";
import {
  INITIAL_FLOW_STATE,
  decodeJobDone,
  decodeJobError,
  decodeJobStart,
  decodeLocaleResult,
  decodeProgress,
  failureFromJobEvent,
  failureFromResponse,
  failureFromTransport,
  flowReducer,
  formatDuration,
  cancelledFailure,
  runTotals,
  truncatedFailure,
  type FlowAction,
  type FlowState,
  type RunRequest,
} from "./machine";

/**
 * The product, end to end.
 *
 * Upload and configure → POST `/api/translate` → consume the SSE stream with
 * the pipeline's own parser → live progress → review → export. This is the only
 * component that performs I/O; the phase it is in comes from `flowReducer`, and
 * every surface below it is one of the existing components rendered with real
 * data.
 *
 * Two things it deliberately does *not* do:
 *
 *   - re-parse or re-serialise the source. The developer's bytes go to the
 *     route verbatim and the route parses them, so "identical to your input" is
 *     measured against the real input.
 *   - hand-roll SSE. `readSseStream` is the same parser the route's encoder was
 *     written against, so a `data:` payload containing a newline round-trips.
 */

export interface TranslationFlowProps {
  provider: ActiveProviderDescription;
  className?: string;
}

/** How wide the shell runs in each phase. The table wants the room; the form does not. */
const NARROW = "1100px";
const WIDE = "1440px";

export function TranslationFlow({ provider, className }: TranslationFlowProps) {
  const [state, rawDispatch] = React.useReducer(flowReducer, INITIAL_FLOW_STATE);
  const abortRef = React.useRef<AbortController | null>(null);
  const anchorRef = React.useRef<HTMLDivElement>(null);

  // Abort any in-flight job if the flow unmounts: closing the stream is what
  // tells the server to stop spending model calls.
  React.useEffect(() => () => abortRef.current?.abort(), []);

  const { dispatch, applyAnchor } = usePhaseScrollAnchor(anchorRef, rawDispatch);
  React.useLayoutEffect(applyAnchor, [state.phase, applyAnchor]);

  const runJob = React.useCallback(async (request: RunRequest) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    dispatch({ type: "run-requested", request, at: Date.now() });

    let settled = false;
    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          fileName: request.catalog.fileName,
          text: request.sourceText,
          settings: request.settings,
        }),
      });

      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        dispatch({
          type: "job-failed",
          failure: failureFromResponse(response.status, body),
        });
        return;
      }

      if (response.body === null) {
        dispatch({ type: "job-failed", failure: truncatedFailure() });
        return;
      }

      for await (const message of readSseStream(response.body)) {
        let data: unknown = null;
        if (message.data.length > 0) {
          try {
            data = JSON.parse(message.data);
          } catch {
            // A frame we cannot read is not a frame we act on.
            continue;
          }
        }

        switch (message.event) {
          case "start": {
            const event = decodeJobStart(data);
            if (event !== null) dispatch({ type: "job-started", event });
            break;
          }
          case "progress": {
            const progress = decodeProgress(data);
            if (progress !== null) dispatch({ type: "progress", progress });
            break;
          }
          case "locale-complete": {
            const result = decodeLocaleResult(data);
            if (result !== null) dispatch({ type: "locale-complete", result });
            break;
          }
          case "done": {
            settled = true;
            dispatch({ type: "job-done", event: decodeJobDone(data), at: Date.now() });
            break;
          }
          case "error": {
            settled = true;
            dispatch({
              type: "job-failed",
              failure: failureFromJobEvent(decodeJobError(data)),
            });
            break;
          }
          default:
            break;
        }
      }

      // The route always ends with `done` or `error`; reaching here means the
      // stream was cut, which is a different problem with a different remedy.
      if (!settled) {
        dispatch({ type: "job-failed", failure: truncatedFailure() });
      }
    } catch (error) {
      dispatch({
        type: "job-failed",
        failure: controller.signal.aborted
          ? cancelledFailure()
          : failureFromTransport(error),
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [dispatch]);

  const handleStart = React.useCallback(
    (catalog: ParsedCatalog, settings: TranslationSettings, sourceText: string) => {
      void runJob({ catalog, settings, sourceText });
    },
    [runJob],
  );

  const handleCatalogChange = React.useCallback(
    (catalog: ParsedCatalog | null) => {
      dispatch({ type: "catalog-loaded", catalog });
    },
    [dispatch],
  );

  const cancel = React.useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const retry = React.useCallback(() => {
    const run = state.phase === "error" ? state.run : null;
    if (run === null) return;
    void runJob(run.request);
  }, [runJob, state]);

  const atForm = state.phase === "idle" || state.phase === "configuring";
  const width = state.phase === "complete" ? WIDE : NARROW;

  return (
    <div className={cn("relative", className)}>
      {atForm && (
        <div
          aria-hidden="true"
          className="grid-backdrop pointer-events-none absolute inset-x-0 top-0 h-[420px]"
        />
      )}

      <div
        ref={anchorRef}
        style={{ maxWidth: width }}
        className="relative mx-auto w-full px-6 pb-24 pt-12 transition-[max-width] duration-500 ease-[var(--ease-out-expo)]"
      >
        {atForm && <Hero />}

        <StepRail phase={state.phase} className="mb-5" />

        {/*
          Provider messaging, once. The header pill carries the *mode* at a
          glance and never moves; this callout carries the *consequence* and
          only appears when there is one, so the two are not the same sentence
          twice. `UploadStage` is deliberately not given `provider` — it would
          render a second copy of this notice inside the form.
        */}
        <ProviderNotice
          provider={provider}
          title={providerConsequence(provider)}
          className="mb-5"
        />

        {atForm && (
          <UploadStage onStart={handleStart} onCatalogChange={handleCatalogChange} />
        )}

        {state.phase === "running" && <RunMonitor run={state.run} onCancel={cancel} />}

        {state.phase === "error" && (
          <FlowErrorPanel
            failure={state.failure}
            run={state.run}
            onRetry={retry}
            onBackToSetup={() => dispatch({ type: "back-to-setup" })}
            onReviewPartial={() => dispatch({ type: "review-partial", at: Date.now() })}
          />
        )}

        {state.phase === "complete" && (
          <div className="space-y-4">
            <CompletionBar
              fileName={state.run.request.catalog.fileName}
              localeCount={state.run.results.length}
              requestedCount={state.run.request.settings.targetLocales.length}
              durationMs={state.finishedAt - state.run.startedAt}
              partial={state.done === null}
              totals={runTotals(state.run.results)}
              onBackToSetup={() => dispatch({ type: "back-to-setup" })}
              onReset={() => dispatch({ type: "reset" })}
            />

            <ReviewPanel
              catalog={state.run.request.catalog}
              results={state.run.results}
              sourceLocale={state.run.request.settings.sourceLocale}
              glossary={state.run.request.settings.glossary}
              exportDirectory=""
              tableHeight={620}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

const CLAIMS: readonly string[] = [
  "Structure, key order and formatting preserved",
  "Placeholders survive exactly",
  "Overflow repaired, not just reported",
];

/**
 * Counted from `LOCALE_PROFILES` rather than typed into the copy, so the
 * headline cannot drift from the code the way a hardcoded number does.
 */
const LANGUAGE_COUNT = selectableLocales("en").length;

function Hero() {
  return (
    <section className="mb-9 max-w-[62ch]">
      <h1 className="text-gradient text-[32px] font-semibold leading-[1.15] tracking-[-0.02em]">
        Ship your UI in {LANGUAGE_COUNT} languages without breaking the layout.
      </h1>
      <p className="mt-3.5 text-[15px] leading-relaxed text-[var(--text-secondary)]">
        Drop in your source catalog. LingoLoop reads the structure, infers what
        each string is for, resolves the words English leaves ambiguous, and
        returns JSON that is byte-shape identical to what you uploaded — with
        every translation measured against the space it has to fit into.
      </p>
      <ul className="mt-5 flex flex-wrap gap-x-5 gap-y-2">
        {CLAIMS.map((claim) => (
          <li
            key={claim}
            className="flex items-center gap-2 text-[13px] text-[var(--text-tertiary)]"
          >
            <CheckGlyph />
            {claim}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step rail
// ---------------------------------------------------------------------------

const STEPS: readonly { id: string; label: string; phases: readonly FlowState["phase"][] }[] = [
  { id: "source", label: "Source", phases: ["idle", "configuring"] },
  { id: "translate", label: "Translate", phases: ["running", "error"] },
  { id: "review", label: "Review", phases: ["complete"] },
];

function StepRail({ phase, className }: { phase: FlowState["phase"]; className?: string }) {
  const current = STEPS.findIndex((step) => step.phases.includes(phase));

  return (
    <ol
      aria-label="Progress through the localization run"
      className={cn("flex flex-wrap items-center gap-x-2 gap-y-1.5", className)}
    >
      {STEPS.map((step, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li
            key={step.id}
            {...(active ? { "aria-current": "step" as const } : {})}
            className="flex items-center gap-2"
          >
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px]",
                "transition-colors duration-300",
                active &&
                  "border-[color-mix(in_oklch,var(--color-accent-500)_38%,transparent)] bg-[color-mix(in_oklch,var(--color-accent-500)_12%,transparent)] text-[var(--text-primary)]",
                done && "border-[var(--border-subtle)] text-[var(--color-ok-400)]",
                !active && !done && "border-[var(--border-subtle)] text-[var(--text-tertiary)]",
              )}
            >
              {/* The mono face and 10.5px size already subordinate the step
                number; a heavier dim would push tertiary text under 4.5:1. */}
            <span className="tabular font-[family-name:var(--font-mono)] text-[10.5px] opacity-90">
                {String(index + 1).padStart(2, "0")}
              </span>
              {step.label}
              {done && <span className="sr-only"> (done)</span>}
            </span>
            {index < STEPS.length - 1 && (
              <span
                aria-hidden="true"
                className={cn(
                  "h-px w-6 transition-colors duration-300",
                  done ? "bg-[var(--color-ok-500)]" : "bg-[var(--border-subtle)]",
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

function CompletionBar({
  fileName,
  localeCount,
  requestedCount,
  durationMs,
  partial,
  totals,
  onBackToSetup,
  onReset,
}: {
  fileName: string;
  localeCount: number;
  requestedCount: number;
  durationMs: number;
  partial: boolean;
  totals: ReturnType<typeof runTotals>;
  onBackToSetup: () => void;
  onReset: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "surface-card animate-in-fade flex flex-wrap items-center gap-x-5 gap-y-3 px-5 py-3.5",
        partial &&
          "border-[color-mix(in_oklch,var(--color-warn-500)_34%,transparent)]",
      )}
    >
      <Badge tone={partial ? "warn" : "ok"} dot>
        {partial ? "Partial run" : "Run complete"}
      </Badge>

      <p className="min-w-0 text-[13px] text-[var(--text-secondary)]">
        <code className="font-[family-name:var(--font-mono)] text-[var(--text-primary)]">
          {fileName}
        </code>{" "}
        → <span className="tabular font-medium">{localeCount}</span>
        {partial && <span className="tabular"> of {requestedCount}</span>}{" "}
        {localeCount === 1 ? "language" : "languages"} ·{" "}
        <span className="tabular">{totals.strings.toLocaleString()}</span> strings ·{" "}
        <span className="tabular font-[family-name:var(--font-mono)]">
          {formatDuration(durationMs)}
        </span>
        {totals.overflowRepaired > 0 && (
          <>
            {" · "}
            <span className="tabular text-[var(--color-accent-400)]">
              {totals.overflowRepaired.toLocaleString()} refitted to their budget
            </span>
          </>
        )}
      </p>

      <span className="ml-auto flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBackToSetup}>
          Change languages
        </Button>
        <Button variant="secondary" size="sm" onClick={onReset}>
          New file
        </Button>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function providerConsequence(provider: ActiveProviderDescription): string {
  if (provider.mode === "simulation") {
    return "This run will be simulated, not translated";
  }
  return provider.ready
    ? "Live model configured"
    : "The configured model cannot be reached";
}

/**
 * Keep the developer's eye where it was across a phase change.
 *
 * Swapping the form for the run panel, or the run panel for a review table,
 * changes the document height by hundreds of pixels — enough that whatever was
 * under the cursor slides away. Every phase change is driven by a dispatch, and
 * a dispatch happens in an event handler or a stream callback, i.e. *before*
 * React re-renders: measuring the container's viewport offset there and
 * correcting the scroll by the delta in a layout effect keeps the anchor
 * stationary. `useLayoutEffect`, so the correction is painted in the same frame
 * rather than as a visible jump-and-snap.
 */
function usePhaseScrollAnchor(
  ref: React.RefObject<HTMLDivElement | null>,
  rawDispatch: React.Dispatch<FlowAction>,
): { dispatch: React.Dispatch<FlowAction>; applyAnchor: () => void } {
  const topBefore = React.useRef<number | null>(null);
  const dispatchRef = React.useRef(rawDispatch);
  dispatchRef.current = rawDispatch;

  const dispatch = React.useCallback(
    (action: FlowAction) => {
      topBefore.current = ref.current?.getBoundingClientRect().top ?? null;
      dispatchRef.current(action);
    },
    [ref],
  );

  const applyAnchor = React.useCallback(() => {
    const before = topBefore.current;
    topBefore.current = null;
    if (before === null || ref.current === null) return;
    const delta = ref.current.getBoundingClientRect().top - before;
    if (Math.abs(delta) < 1) return;
    window.scrollBy({ top: delta, behavior: "auto" });
  }, [ref]);

  return { dispatch, applyAnchor };
}

function CheckGlyph() {
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
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
