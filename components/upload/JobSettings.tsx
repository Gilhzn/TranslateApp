"use client";

import * as React from "react";
import type { LocaleCode, ToneProfile } from "@/lib/types";
import { Badge, cn } from "@/components/ui";
import { profilesFor } from "./locale-search";
import {
  MAX_REPAIR_ATTEMPTS,
  MIN_REPAIR_ATTEMPTS,
  PRODUCT_CONTEXT_LIMIT,
  TONE_OPTIONS,
  newGlossaryDraft,
  type GlossaryDraft,
  type SettingsDraft,
} from "./settings-model";

export interface JobSettingsProps {
  draft: SettingsDraft;
  onChange: (next: SettingsDraft) => void;
  disabled?: boolean;
}

const PRODUCT_CONTEXT_PLACEHOLDER = `Emberfall is a roguelike deckbuilder for PC. The player is called "the Runner"; card and relic names are proper nouns and stay in English. Menu buttons sit in a 120px column, so labels have to stay short. The voice is dry and a little smug.`;

let glossarySeq = 0;
function nextGlossaryId(): string {
  glossarySeq += 1;
  return `glossary-${glossarySeq}`;
}

export function JobSettings({ draft, onChange, disabled = false }: JobSettingsProps) {
  const patch = React.useCallback(
    (partial: Partial<SettingsDraft>) => onChange({ ...draft, ...partial }),
    [draft, onChange],
  );

  return (
    <section className="surface-card overflow-hidden" aria-label="Job settings">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--border-subtle)] px-5 py-4">
        <h2 className="text-[13px] font-medium tracking-tight text-[var(--text-primary)]">
          Job settings
        </h2>
        <p className="ml-auto text-[12px] text-[var(--text-tertiary)]">
          Everything here is threaded into every prompt.
        </p>
      </header>

      <ToneSection
        tone={draft.tone}
        onSelect={(tone) => patch({ tone })}
        disabled={disabled}
      />

      <ContextSection
        value={draft.productContext}
        onChange={(productContext) => patch({ productContext })}
        disabled={disabled}
      />

      <GlossarySection
        drafts={draft.glossary}
        targetLocales={draft.targetLocales}
        onChange={(glossary) => patch({ glossary })}
        disabled={disabled}
      />

      <GuardrailsSection
        enforceLayout={draft.enforceLayout}
        maxRepairAttempts={draft.maxRepairAttempts}
        onChange={patch}
        disabled={disabled}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tone
// ---------------------------------------------------------------------------

function ToneSection({
  tone,
  onSelect,
  disabled,
}: {
  tone: ToneProfile;
  onSelect: (tone: ToneProfile) => void;
  disabled: boolean;
}) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>, index: number) => {
    const delta =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = (index + delta + TONE_OPTIONS.length) % TONE_OPTIONS.length;
    const option = TONE_OPTIONS[next];
    if (option === undefined) return;
    onSelect(option.tone);
    refs.current[next]?.focus();
  };

  return (
    <Field
      label="Tone"
      hint="The register every string is written in. Getting this wrong is the most visible localisation failure there is."
    >
      <div
        role="radiogroup"
        aria-label="Tone"
        className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
      >
        {TONE_OPTIONS.map((option, index) => {
          const active = option.tone === tone;
          return (
            <button
              key={option.tone}
              type="button"
              role="radio"
              aria-checked={active}
              // Roving tabindex: the group is one tab stop, arrows move inside.
              tabIndex={active ? 0 : -1}
              disabled={disabled}
              ref={(node) => {
                refs.current[index] = node;
              }}
              onClick={() => onSelect(option.tone)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "flex flex-col gap-1 rounded-[var(--radius-lg)] border px-3.5 py-3 text-left",
                "transition-[background-color,border-color] duration-150",
                "disabled:pointer-events-none disabled:opacity-50",
                active
                  ? "border-[color-mix(in_oklch,var(--color-accent-500)_55%,transparent)] bg-[color-mix(in_oklch,var(--color-accent-500)_12%,transparent)]"
                  : "border-[var(--border-subtle)] bg-[var(--surface-1)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)]",
              )}
            >
              <span
                className={cn(
                  "flex items-center gap-2 text-[13px] font-medium",
                  active ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border",
                    active
                      ? "border-[var(--color-accent-400)]"
                      : "border-[var(--border-strong)]",
                  )}
                >
                  {active && (
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent-400)]" />
                  )}
                </span>
                {option.label}
              </span>
              {/* The selected card sits on an accent-tinted surface, which is
                  lighter than surface-1; tertiary would land at 4.49:1 there.
                  Lifting to secondary keeps AA and mirrors the label's own
                  selected/unselected step. */}
              <span
                className={cn(
                  "text-[12px] leading-relaxed",
                  active ? "text-[var(--text-secondary)]" : "text-[var(--text-tertiary)]",
                )}
              >
                {option.summary}
              </span>
            </button>
          );
        })}
      </div>
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Product context
// ---------------------------------------------------------------------------

function ContextSection({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const remaining = PRODUCT_CONTEXT_LIMIT - value.length;

  return (
    <Field
      label="Product context"
      hint="Free text sent with every batch. Name the product, the audience, the constraints and anything that must not be translated."
      trailing={
        <span
          className={cn(
            "tabular text-[11px]",
            remaining < 0 ? "text-[var(--color-danger-400)]" : "text-[var(--text-tertiary)]",
          )}
        >
          {value.length}/{PRODUCT_CONTEXT_LIMIT}
        </span>
      }
    >
      <textarea
        value={value}
        disabled={disabled}
        rows={4}
        maxLength={PRODUCT_CONTEXT_LIMIT}
        onChange={(event) => onChange(event.target.value)}
        placeholder={PRODUCT_CONTEXT_PLACEHOLDER}
        aria-label="Product context"
        className={cn(
          "w-full resize-y rounded-[var(--radius-lg)] border border-[var(--border-subtle)]",
          "bg-[var(--surface-1)] px-3.5 py-3 text-[13px] leading-relaxed text-[var(--text-primary)]",
          "placeholder:text-[var(--text-tertiary)]",
          "transition-colors focus:border-[var(--border-strong)] focus:outline-none",
          "disabled:opacity-50",
        )}
      />
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Glossary
// ---------------------------------------------------------------------------

function GlossarySection({
  drafts,
  targetLocales,
  onChange,
  disabled,
}: {
  drafts: readonly GlossaryDraft[];
  targetLocales: readonly LocaleCode[];
  onChange: (next: GlossaryDraft[]) => void;
  disabled: boolean;
}) {
  const profiles = React.useMemo(() => profilesFor(targetLocales), [targetLocales]);

  const update = (id: string, partial: Partial<GlossaryDraft>) => {
    onChange(drafts.map((row) => (row.id === id ? { ...row, ...partial } : row)));
  };

  return (
    <Field
      label="Glossary"
      hint="Terms the model is not free to reinterpret. Empty renderings mean the term is carried through verbatim."
      trailing={
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange([...drafts, newGlossaryDraft(nextGlossaryId())])}
          className={cn(
            "rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--surface-2)]",
            "px-2.5 py-1 text-[12px] text-[var(--text-secondary)] transition-colors",
            "hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]",
            "disabled:pointer-events-none disabled:opacity-50",
          )}
        >
          + Add term
        </button>
      }
    >
      {drafts.length === 0 ? (
        <p className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-subtle)] px-3.5 py-4 text-[13px] leading-relaxed text-[var(--text-tertiary)]">
          No glossary terms. Add your product name, feature names and any term
          your users already say in English — they will otherwise be translated
          into something nobody in your community recognises.
        </p>
      ) : (
        <ul className="space-y-2">
          {drafts.map((row) => (
            <li
              key={row.id}
              className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={row.term}
                  disabled={disabled}
                  onChange={(event) => update(row.id, { term: event.target.value })}
                  placeholder="Term, e.g. Shipyard"
                  aria-label="Glossary term"
                  className={cn(
                    "h-8 min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--border-subtle)]",
                    "bg-[var(--surface-2)] px-2.5 font-[family-name:var(--font-mono)] text-[13px]",
                    "text-[var(--text-primary)] placeholder:font-[family-name:var(--font-sans)]",
                    "placeholder:text-[var(--text-tertiary)]",
                    "focus:border-[var(--border-strong)] focus:outline-none disabled:opacity-50",
                  )}
                />

                <Toggle
                  checked={row.keepVerbatim}
                  disabled={disabled}
                  onChange={(keepVerbatim) => update(row.id, { keepVerbatim })}
                  label="Keep verbatim"
                  description="Never translated in any locale."
                />

                <Toggle
                  checked={row.caseSensitive}
                  disabled={disabled}
                  onChange={(caseSensitive) => update(row.id, { caseSensitive })}
                  label="Case-sensitive"
                  description="Only matches the exact casing typed above."
                />

                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange(drafts.filter((item) => item.id !== row.id))}
                  aria-label={`Remove glossary term${row.term.trim() ? ` ${row.term.trim()}` : ""}`}
                  className={cn(
                    "grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-sm)]",
                    "text-[var(--text-tertiary)] transition-colors",
                    "hover:bg-[var(--surface-3)] hover:text-[var(--color-danger-400)]",
                    "disabled:pointer-events-none disabled:opacity-50",
                  )}
                >
                  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
                    <path
                      d="M3 4.5h10M6.5 4.5V3.2h3v1.3M5 4.5l.6 8h4.8l.6-8"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>

              <input
                type="text"
                value={row.note}
                disabled={disabled}
                onChange={(event) => update(row.id, { note: event.target.value })}
                placeholder="Optional note for the model — “our deploy target, not the verb”"
                aria-label="Glossary note"
                className={cn(
                  "mt-2 h-8 w-full rounded-[var(--radius-sm)] border border-[var(--border-subtle)]",
                  "bg-[var(--surface-2)] px-2.5 text-[12px] text-[var(--text-secondary)]",
                  "placeholder:text-[var(--text-tertiary)]",
                  "focus:border-[var(--border-strong)] focus:outline-none disabled:opacity-50",
                )}
              />

              {!row.keepVerbatim && (
                <div className="mt-2.5">
                  {profiles.length === 0 ? (
                    <p className="text-[12px] text-[var(--text-tertiary)]">
                      Select target languages to enter a forced rendering for each.
                    </p>
                  ) : (
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {profiles.map((profile) => (
                        <label
                          key={profile.code}
                          className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--surface-2)] px-2 py-1"
                        >
                          <span className="w-12 shrink-0 font-[family-name:var(--font-mono)] text-[11px] text-[var(--color-accent-400)]">
                            {profile.code}
                          </span>
                          <input
                            type="text"
                            value={row.translations[profile.code] ?? ""}
                            disabled={disabled}
                            onChange={(event) =>
                              update(row.id, {
                                translations: {
                                  ...row.translations,
                                  [profile.code]: event.target.value,
                                },
                              })
                            }
                            placeholder={`${profile.nativeName} rendering`}
                            aria-label={`${profile.name} rendering for ${row.term || "this term"}`}
                            className={cn(
                              "h-6 min-w-0 flex-1 bg-transparent text-[12px] text-[var(--text-primary)]",
                              "placeholder:text-[var(--text-tertiary)] focus:outline-none disabled:opacity-50",
                            )}
                          />
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

function GuardrailsSection({
  enforceLayout,
  maxRepairAttempts,
  onChange,
  disabled,
}: {
  enforceLayout: boolean;
  maxRepairAttempts: number;
  onChange: (partial: Partial<SettingsDraft>) => void;
  disabled: boolean;
}) {
  const attempts: number[] = [];
  for (let n = MIN_REPAIR_ATTEMPTS; n <= MAX_REPAIR_ATTEMPTS; n++) attempts.push(n);

  return (
    <Field label="Guardrails" hint="What happens when a translation does not fit.">
      <div className="grid gap-2 lg:grid-cols-2">
        <div
          className={cn(
            "flex items-start gap-3 rounded-[var(--radius-lg)] border px-3.5 py-3",
            enforceLayout
              ? "border-[color-mix(in_oklch,var(--color-accent-500)_40%,transparent)] bg-[color-mix(in_oklch,var(--color-accent-500)_8%,transparent)]"
              : "border-[var(--border-subtle)] bg-[var(--surface-1)]",
          )}
        >
          <Switch
            checked={enforceLayout}
            disabled={disabled}
            onChange={(value) => onChange({ enforceLayout: value })}
            label="Enforce layout budgets"
          />
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-[var(--text-primary)]">
              Enforce layout budgets
            </p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-tertiary)]">
              {enforceLayout
                ? "Every string is measured against its role's width budget, and anything that overflows is sent back for a shorter rendering."
                : "Overflow is reported but not repaired. Translations may be wider than the space your UI gives them."}
            </p>
          </div>
        </div>

        <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-1)] px-3.5 py-3">
          <div className="flex items-center gap-2">
            <p className="text-[13px] font-medium text-[var(--text-primary)]">
              Repair attempts
            </p>
            <Badge tone={maxRepairAttempts === 0 ? "neutral" : "accent"}>
              {maxRepairAttempts === 0 ? "off" : `up to ${maxRepairAttempts}`}
            </Badge>
          </div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-tertiary)]">
            Extra model calls per string after the first pass. Each one gets the
            exact issue back as feedback.
          </p>
          <div
            role="radiogroup"
            aria-label="Maximum repair attempts"
            className="mt-2.5 inline-flex rounded-[var(--radius-sm)] border border-[var(--border-subtle)] p-0.5"
          >
            {attempts.map((value) => {
              const active = value === maxRepairAttempts;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  tabIndex={active ? 0 : -1}
                  disabled={disabled}
                  onClick={() => onChange({ maxRepairAttempts: value })}
                  onKeyDown={(event) => {
                    const delta =
                      event.key === "ArrowRight"
                        ? 1
                        : event.key === "ArrowLeft"
                          ? -1
                          : 0;
                    if (delta === 0) return;
                    event.preventDefault();
                    const next = Math.min(
                      MAX_REPAIR_ATTEMPTS,
                      Math.max(MIN_REPAIR_ATTEMPTS, maxRepairAttempts + delta),
                    );
                    onChange({ maxRepairAttempts: next });
                  }}
                  className={cn(
                    "tabular h-7 w-9 rounded-[calc(var(--radius-sm)-2px)] text-[12px] transition-colors",
                    "disabled:pointer-events-none disabled:opacity-50",
                    active
                      ? "bg-[var(--color-ink-50)] font-medium text-[var(--color-ink-950)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--surface-3)]",
                  )}
                >
                  {value}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function Field({
  label,
  hint,
  trailing,
  children,
}: {
  label: string;
  hint: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-[var(--border-subtle)] px-5 py-4 last:border-b-0">
      <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
          {label}
        </h3>
        <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-[var(--text-tertiary)]">
          {hint}
        </p>
        {trailing}
      </div>
      {children}
    </div>
  );
}

function Switch({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative mt-0.5 h-[18px] w-8 shrink-0 rounded-full border transition-colors duration-150",
        "disabled:pointer-events-none disabled:opacity-50",
        checked
          ? "border-transparent bg-[var(--color-accent-500)]"
          : "border-[var(--border-strong)] bg-[var(--surface-3)]",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-[2px] h-3 w-3 rounded-full bg-white transition-[left] duration-150 ease-[var(--ease-out-expo)]",
          checked ? "left-[16px]" : "left-[2px]",
        )}
      />
    </button>
  );
}

/** Compact inline switch with its label visible — used inside glossary rows. */
function Toggle({
  checked,
  disabled,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      title={description}
      onClick={() => onChange(!checked)}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-2 rounded-[var(--radius-sm)] border px-2.5",
        "text-[12px] transition-colors duration-150",
        "disabled:pointer-events-none disabled:opacity-50",
        checked
          ? "border-[color-mix(in_oklch,var(--color-accent-500)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-accent-500)_12%,transparent)] text-[var(--text-primary)]"
          : "border-[var(--border-subtle)] bg-[var(--surface-2)] text-[var(--text-tertiary)] hover:border-[var(--border-strong)]",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "relative h-3.5 w-6 rounded-full transition-colors duration-150",
          checked ? "bg-[var(--color-accent-500)]" : "bg-[var(--color-ink-700)]",
        )}
      >
        <span
          className={cn(
            "absolute top-[2px] h-2.5 w-2.5 rounded-full bg-white transition-[left] duration-150",
            checked ? "left-[12px]" : "left-[2px]",
          )}
        />
      </span>
      {label}
    </button>
  );
}
