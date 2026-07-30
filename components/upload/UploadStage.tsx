"use client";

import * as React from "react";
import type { TranslationSettings } from "@/lib/types";
import type { ParsedCatalog } from "@/lib/core";
import type { ActiveProviderDescription } from "@/lib/engine";
import { Button, cn } from "@/components/ui";
import { CatalogSummary } from "./CatalogSummary";
import { DropZone } from "./DropZone";
import { JobSettings } from "./JobSettings";
import { LocalePicker } from "./LocalePicker";
import { ProviderNotice } from "./ProviderIndicator";
import { formatCount } from "./catalog-insights";
import type { UploadFailure } from "./file-validation";
import { profilesFor, worstExpansion } from "./locale-search";
import {
  buildTranslationSettings,
  estimateUnits,
  initialSettingsDraft,
  startBlockers,
  type SettingsDraft,
} from "./settings-model";

/**
 * The upload flow, end to end: drop or paste a catalog, see what was
 * understood, choose targets and register, hand a complete
 * {@link TranslationSettings} to the orchestrator.
 *
 * This component never calls the API. `onStart` is the whole contract.
 */

export type StartHandler = (
  catalog: ParsedCatalog,
  settings: TranslationSettings,
  /**
   * The bytes the catalog was parsed from. `/api/translate` parses the source
   * itself and must see the developer's file, not a reconstruction of it.
   */
  sourceText: string,
) => void;

export interface UploadStageProps {
  /** Read on the server and passed down, so the mode shown is the real one. */
  provider?: ActiveProviderDescription;
  /**
   * Supplied by the pipeline orchestrator. Without it the stage still works and
   * the action opens the run-request inspector instead of dispatching a job.
   */
  onStart?: StartHandler;
  /**
   * Fired whenever the loaded catalog changes — a successful parse, or `null`
   * when there is nothing loaded. Lets the orchestrator show where the
   * developer is in the flow without owning the form's state.
   */
  onCatalogChange?: (catalog: ParsedCatalog | null) => void;
  /** True while the orchestrator is running; locks the whole form. */
  busy?: boolean;
  className?: string;
}

export function UploadStage({
  provider,
  onStart,
  onCatalogChange,
  busy = false,
  className,
}: UploadStageProps) {
  // `parsing` is the only transient bit of the flow; the parsed state *is*
  // `catalog !== null`, so the two can never disagree.
  const [parsing, setParsing] = React.useState(false);
  const [catalog, setCatalog] = React.useState<ParsedCatalog | null>(null);
  // Held beside the catalog rather than derived from it, so the job posts the
  // file the developer dropped rather than a re-serialisation of its tree.
  const [sourceText, setSourceText] = React.useState("");
  const [failure, setFailure] = React.useState<UploadFailure | null>(null);
  const [draft, setDraft] = React.useState<SettingsDraft>(() =>
    initialSettingsDraft("en"),
  );
  const [attempted, setAttempted] = React.useState(false);
  const [inspecting, setInspecting] = React.useState(false);

  const inspectorRef = React.useRef<HTMLDivElement>(null);
  const summaryRef = React.useRef<HTMLDivElement>(null);
  const summaryHeadingRef = React.useRef<HTMLHeadingElement>(null);
  // Bumped once per successful parse. The scroll cannot happen inside the
  // parse handler — the summary panel does not exist until React has committed
  // the new state — so a counter carries the intent into an effect.
  const [landings, setLandings] = React.useState(0);

  const onParseStart = React.useCallback(() => {
    setParsing(true);
    setFailure(null);
  }, []);

  // A ref so a parent that passes an inline arrow does not re-create the
  // DropZone's handler identity on every render.
  const notifyRef = React.useRef(onCatalogChange);
  notifyRef.current = onCatalogChange;

  const onCatalog = React.useCallback((next: ParsedCatalog, text: string) => {
    setCatalog(next);
    setSourceText(text);
    setFailure(null);
    setParsing(false);
    setAttempted(false);
    setInspecting(false);
    setLandings((count) => count + 1);
    notifyRef.current?.(next);
    // A new file may be a different source language; keep the developer's tone,
    // context, glossary and guardrails, but re-anchor the source locale and drop
    // a target that has become the source.
    setDraft((current) => ({
      ...current,
      sourceLocale: next.sourceLocale,
      targetLocales: current.targetLocales.filter((code) => code !== next.sourceLocale),
    }));
  }, []);

  /**
   * A parse adds ~2,000px of analysis below the drop zone, and the developer
   * is reading the drop zone. Land them on the top of "What we understood" —
   * the thing the app just computed — rather than leaving the viewport where
   * it was or, worse, letting some descendant pick the offset for us. Focus
   * follows the scroll so keyboard and screen-reader users arrive with it, and
   * `preventScroll` keeps that focus call from fighting the smooth animation.
   */
  React.useEffect(() => {
    if (landings === 0) return;
    const panel = summaryRef.current;
    if (panel === null) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    panel.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
    summaryHeadingRef.current?.focus({ preventScroll: true });
  }, [landings]);

  const onFailure = React.useCallback((next: UploadFailure) => {
    setFailure(next);
    setParsing(false);
  }, []);

  const settings = React.useMemo(() => buildTranslationSettings(draft), [draft]);

  const blockers = React.useMemo(
    () =>
      startBlockers({
        hasCatalog: catalog !== null,
        translatableKeys: catalog?.stats.translatableKeys ?? 0,
        targetLocales: settings.targetLocales,
      }),
    [catalog, settings.targetLocales],
  );

  const ready = blockers.length === 0 && catalog !== null;
  const missingLocales = blockers.some((blocker) => blocker.code === "no-locales");

  const announcement = React.useMemo(() => {
    if (failure !== null) return `Upload failed. ${failure.title}. ${failure.detail}`;
    if (parsing) return "Parsing catalog…";
    if (catalog === null) return "No catalog loaded.";
    return `Parsed ${catalog.fileName}: ${formatCount(catalog.stats.totalKeys)} keys, ${formatCount(
      catalog.stats.translatableKeys,
    )} translatable, ${formatCount(catalog.stats.skippedKeys)} skipped, max depth ${catalog.stats.maxDepth}.`;
  }, [catalog, failure, parsing]);

  const start = () => {
    setAttempted(true);
    if (!ready || catalog === null) return;
    if (onStart !== undefined) {
      onStart(catalog, settings, sourceText);
      return;
    }
    // No orchestrator wired yet: show exactly what would have been dispatched
    // rather than pretending a job started.
    setInspecting(true);
    requestAnimationFrame(() => inspectorRef.current?.focus());
  };

  return (
    <div className={cn("space-y-5", className)}>
      {provider !== undefined && <ProviderNotice provider={provider} />}

      <DropZone
        onCatalog={onCatalog}
        onFailure={onFailure}
        onParseStart={onParseStart}
        parsing={parsing}
        failure={failure}
        onDismissFailure={() => setFailure(null)}
        loadedFileName={catalog?.fileName ?? null}
        loadedSummary={
          catalog === null
            ? undefined
            : `${formatCount(catalog.stats.translatableKeys)} translatable of ${formatCount(
                catalog.stats.totalKeys,
              )} keys · source ${catalog.sourceLocale}`
        }
        disabled={busy}
      />

      {/* Announced to screen readers whenever a parse settles. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {catalog === null ? (
        <IdleGuide parsing={parsing} />
      ) : (
        <>
          {/*
            The scroll target is this wrapper, not the card: the card plays
            `animate-in-rise`, and measuring a mid-animation transform would
            land the developer 8px off. The wrapper's box is the settled one.
            `scroll-mt` clears the 57px sticky header with air to spare.
          */}
          <div ref={summaryRef} className="scroll-mt-[4.5rem]">
            <CatalogSummary headingRef={summaryHeadingRef} catalog={catalog} />
          </div>

          <LocalePicker
            sourceLocale={draft.sourceLocale}
            selected={draft.targetLocales}
            onChange={(targetLocales) =>
              setDraft((current) => ({ ...current, targetLocales }))
            }
            disabled={busy}
            invalid={attempted && missingLocales}
          />

          <JobSettings draft={draft} onChange={setDraft} disabled={busy} />

          <ActionBar
            catalog={catalog}
            settings={settings}
            blockers={blockers.map((blocker) => blocker.message)}
            showBlockers={attempted}
            ready={ready}
            busy={busy}
            wired={onStart !== undefined}
            onStart={start}
          />

          {inspecting && (
            <RunRequestInspector
              ref={inspectorRef}
              catalog={catalog}
              settings={settings}
              onClose={() => setInspecting(false)}
            />
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Idle
// ---------------------------------------------------------------------------

const STEPS: readonly { title: string; body: string }[] = [
  {
    title: "Parse and analyse",
    body: "Keys are flattened, placeholders extracted, UI roles inferred and ambiguous words flagged — all in your browser, before anything is sent.",
  },
  {
    title: "Translate inside a budget",
    body: "Every string carries a width budget derived from its role and the target script. Anything that overflows is sent back with the exact number of characters to cut.",
  },
  {
    title: "Review and export",
    body: "Diff every string against the source, then export JSON with the same keys, order, nesting, indentation and line endings you uploaded.",
  },
];

function IdleGuide({ parsing }: { parsing: boolean }) {
  return (
    <div
      className={cn(
        "grid gap-px overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--border-subtle)] sm:grid-cols-3",
        parsing && "opacity-60",
      )}
      aria-hidden={parsing || undefined}
    >
      {STEPS.map((step, index) => (
        <div key={step.title} className="bg-[var(--surface-1)] px-5 py-4">
          <span className="tabular font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
            {String(index + 1).padStart(2, "0")}
          </span>
          <h3 className="mt-1.5 text-[13px] font-medium text-[var(--text-primary)]">
            {step.title}
          </h3>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-tertiary)]">
            {step.body}
          </p>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Action bar
// ---------------------------------------------------------------------------

function ActionBar({
  catalog,
  settings,
  blockers,
  showBlockers,
  ready,
  busy,
  wired,
  onStart,
}: {
  catalog: ParsedCatalog;
  settings: TranslationSettings;
  blockers: readonly string[];
  showBlockers: boolean;
  ready: boolean;
  busy: boolean;
  wired: boolean;
  onStart: () => void;
}) {
  const units = estimateUnits(catalog.stats.translatableKeys, settings.targetLocales);
  const widest = worstExpansion(settings.targetLocales);
  const profiles = profilesFor(settings.targetLocales);

  return (
    <div
      className={cn(
        "surface-card sticky bottom-4 z-10 flex flex-wrap items-center gap-x-5 gap-y-3 px-5 py-4",
        "shadow-[0_16px_40px_-16px_rgba(0,0,0,0.7)] backdrop-blur-sm",
      )}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-[13px] text-[var(--text-primary)]">
          <span className="tabular font-medium">
            {formatCount(catalog.stats.translatableKeys)}
          </span>{" "}
          strings
          {profiles.length > 0 && (
            <>
              {" × "}
              <span className="tabular font-medium">{profiles.length}</span>{" "}
              language{profiles.length === 1 ? "" : "s"}
              {" = "}
              <span className="tabular font-medium">{formatCount(units)}</span> units
            </>
          )}
        </p>
        {widest !== null && widest.expansion > 1.05 ? (
          <p className="text-[12px] text-[var(--text-tertiary)]">
            Tightest fit: {widest.nativeName} ({widest.code}) runs about{" "}
            {Math.round((widest.expansion - 1) * 100)}% longer than the source.
            {settings.enforceLayout
              ? " Layout enforcement is on, so overflow will be repaired."
              : " Layout enforcement is off — overflow will only be reported."}
          </p>
        ) : (
          <p className="text-[12px] text-[var(--text-tertiary)]">
            {settings.glossary.length > 0
              ? `${settings.glossary.length} glossary term${settings.glossary.length === 1 ? "" : "s"} pinned · `
              : ""}
            Tone: {settings.tone.replace(/-/g, " ")}
          </p>
        )}

        {showBlockers && blockers.length > 0 && (
          <ul role="alert" className="space-y-0.5 pt-0.5">
            {blockers.map((message) => (
              <li key={message} className="text-[12px] text-[var(--color-danger-400)]">
                {message}
              </li>
            ))}
          </ul>
        )}
      </div>

      <Button
        variant="primary"
        size="lg"
        onClick={onStart}
        loading={busy}
        aria-disabled={!ready || undefined}
        className={cn(!ready && !busy && "opacity-60")}
      >
        {wired ? "Translate" : "Preview run request"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run request inspector
// ---------------------------------------------------------------------------

const RunRequestInspector = React.forwardRef<
  HTMLDivElement,
  {
    catalog: ParsedCatalog;
    settings: TranslationSettings;
    onClose: () => void;
  }
>(function RunRequestInspector({ catalog, settings, onClose }, ref) {
  const body = React.useMemo(
    () =>
      JSON.stringify(
        {
          source: {
            fileName: catalog.fileName,
            locale: catalog.sourceLocale,
            translatableKeys: catalog.stats.translatableKeys,
            indent: catalog.indent === "" ? "(minified)" : catalog.indent,
            trailingNewline: catalog.trailingNewline,
          },
          settings,
        },
        null,
        2,
      ),
    [catalog, settings],
  );

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="surface-card animate-in-rise overflow-hidden"
      aria-label="Run request"
    >
      <header className="flex items-center gap-3 border-b border-[var(--border-subtle)] px-5 py-3.5">
        <h2 className="text-[13px] font-medium text-[var(--text-primary)]">
          Run request
        </h2>
        <p className="min-w-0 flex-1 text-[12px] text-[var(--text-tertiary)]">
          Exactly what will be handed to the pipeline. No network call has been made.
        </p>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </header>
      <pre className="max-h-[22rem] overflow-auto px-5 py-4 font-[family-name:var(--font-mono)] text-[12px] leading-[1.65] text-[var(--text-secondary)]">
        <code>{body}</code>
      </pre>
    </div>
  );
});
