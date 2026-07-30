"use client";

import * as React from "react";
import type { LocaleCode, LocaleProfile } from "@/lib/types";
import { Badge, cn } from "@/components/ui";
import {
  POPULAR_LOCALES,
  expansionRisk,
  filterLocaleProfiles,
  formatExpansion,
  localeTags,
  profilesFor,
  selectableLocales,
} from "./locale-search";

export interface LocalePickerProps {
  sourceLocale: LocaleCode;
  selected: readonly LocaleCode[];
  onChange: (next: LocaleCode[]) => void;
  disabled?: boolean;
  /** Rendered when nothing is selected and the developer has tried to start. */
  invalid?: boolean;
}

const LIST_ID = "lingoloop-locale-list";

const RISK_TEXT: Record<ReturnType<typeof expansionRisk>, string> = {
  none: "text-[var(--text-tertiary)]",
  low: "text-[var(--text-secondary)]",
  high: "text-[var(--color-warn-400)]",
};

export function LocalePicker({
  sourceLocale,
  selected,
  onChange,
  disabled = false,
  invalid = false,
}: LocalePickerProps) {
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const listRef = React.useRef<HTMLUListElement>(null);

  const all = React.useMemo(() => selectableLocales(sourceLocale), [sourceLocale]);
  const visible = React.useMemo(() => filterLocaleProfiles(all, query), [all, query]);
  const selectedSet = React.useMemo(() => new Set(selected), [selected]);
  const selectedProfiles = React.useMemo(() => profilesFor(selected), [selected]);

  // A shrinking result set must not leave the cursor pointing past the end.
  const clampedActive = visible.length === 0 ? -1 : Math.min(activeIndex, visible.length - 1);
  const activeProfile = clampedActive >= 0 ? visible[clampedActive] : undefined;
  const activeId = activeProfile ? optionId(activeProfile.code) : undefined;

  React.useEffect(() => {
    if (activeId === undefined || listRef.current === null) return;
    const node = document.getElementById(activeId);
    if (node !== null) node.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const toggle = React.useCallback(
    (code: LocaleCode) => {
      if (disabled) return;
      onChange(
        selectedSet.has(code)
          ? selected.filter((item) => item !== code)
          : [...selected, code],
      );
    },
    [disabled, onChange, selected, selectedSet],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (visible.length === 0) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((index) => (Math.min(index, visible.length - 1) + 1) % visible.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex(
          (index) =>
            (Math.min(index, visible.length - 1) + visible.length - 1) % visible.length,
        );
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(visible.length - 1);
        break;
      case "Enter":
        event.preventDefault();
        if (activeProfile !== undefined) toggle(activeProfile.code);
        break;
      default:
        break;
    }
  };

  const quickAdd = POPULAR_LOCALES.filter(
    (code) => !selectedSet.has(code) && code !== sourceLocale,
  );

  return (
    <section
      className={cn(
        "surface-card overflow-hidden",
        invalid &&
          "border-[color-mix(in_oklch,var(--color-danger-500)_45%,transparent)]",
      )}
      aria-label="Target languages"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--border-subtle)] px-5 py-4">
        <h2 className="text-[13px] font-medium tracking-tight text-[var(--text-primary)]">
          Target languages
        </h2>
        <Badge tone={selected.length > 0 ? "accent" : "neutral"}>
          {selected.length} selected
        </Badge>
        <p className="ml-auto text-[12px] text-[var(--text-tertiary)]">
          Expansion is the average character growth versus {sourceLocale}.
        </p>
      </header>

      {/* Selected chips */}
      <div className="border-b border-[var(--border-subtle)] px-5 py-3.5">
        {selectedProfiles.length === 0 ? (
          <p
            className={cn(
              "text-[13px]",
              invalid ? "text-[var(--color-danger-400)]" : "text-[var(--text-tertiary)]",
            )}
          >
            No languages selected yet — pick at least one below to enable the run.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {selectedProfiles.map((profile) => (
              <span
                key={profile.code}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-2.5 pr-1",
                  "border-[color-mix(in_oklch,var(--color-accent-500)_34%,transparent)]",
                  "bg-[color-mix(in_oklch,var(--color-accent-500)_14%,transparent)]",
                  "text-[12px] text-[var(--text-primary)]",
                )}
              >
                <span className="font-[family-name:var(--font-mono)] text-[var(--color-accent-400)]">
                  {profile.code}
                </span>
                <span className="text-[var(--text-secondary)]">{profile.nativeName}</span>
                <button
                  type="button"
                  onClick={() => toggle(profile.code)}
                  disabled={disabled}
                  aria-label={`Remove ${profile.name}`}
                  className={cn(
                    "grid h-4 w-4 place-items-center rounded-full text-[var(--text-tertiary)]",
                    "transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]",
                    "disabled:pointer-events-none disabled:opacity-50",
                  )}
                >
                  <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" aria-hidden="true">
                    <path
                      d="m3 3 6 6M9 3l-6 6"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={() => onChange([])}
              disabled={disabled}
              className={cn(
                "ml-1 rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[12px] text-[var(--text-tertiary)]",
                "transition-colors hover:text-[var(--text-primary)]",
                "disabled:pointer-events-none disabled:opacity-50",
              )}
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      {/* Search */}
      <div className="relative border-b border-[var(--border-subtle)]">
        <SearchGlyph className="pointer-events-none absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-tertiary)]" />
        <input
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={LIST_ID}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-label="Search languages by code, English name or native name"
          value={query}
          disabled={disabled}
          placeholder="Search — de, German, Deutsch…"
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
          className={cn(
            "h-11 w-full bg-transparent pl-12 pr-5 text-[13px] text-[var(--text-primary)]",
            "placeholder:text-[var(--text-tertiary)] focus:outline-none",
            "disabled:opacity-50",
          )}
        />
      </div>

      {/* Quick add */}
      {quickAdd.length > 0 && query.trim().length === 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--border-subtle)] px-5 py-2.5">
          <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
            Quick add
          </span>
          {quickAdd.map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => toggle(code)}
              disabled={disabled}
              className={cn(
                "rounded-full border border-[var(--border-subtle)] bg-[var(--surface-2)] px-2.5 py-0.5",
                "font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)]",
                "transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]",
                "disabled:pointer-events-none disabled:opacity-50",
              )}
            >
              + {code}
            </button>
          ))}
        </div>
      )}

      {/* Options */}
      {visible.length === 0 ? (
        <p className="px-5 py-8 text-center text-[13px] text-[var(--text-tertiary)]">
          No language matches “{query.trim()}”. Try a code (<code>pt-BR</code>), an
          English name, or the native spelling.
        </p>
      ) : (
        <ul
          ref={listRef}
          id={LIST_ID}
          role="listbox"
          aria-multiselectable="true"
          aria-label="Available languages"
          className="max-h-[19rem] overflow-y-auto overscroll-contain"
        >
          {visible.map((profile, index) => (
            <LocaleOption
              key={profile.code}
              profile={profile}
              selected={selectedSet.has(profile.code)}
              active={index === clampedActive}
              disabled={disabled}
              onToggle={toggle}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function optionId(code: LocaleCode): string {
  return `lingoloop-locale-${code}`;
}

function LocaleOption({
  profile,
  selected,
  active,
  disabled,
  onToggle,
}: {
  profile: LocaleProfile;
  selected: boolean;
  active: boolean;
  disabled: boolean;
  onToggle: (code: LocaleCode) => void;
}) {
  const tags = localeTags(profile);
  const risk = expansionRisk(profile);

  return (
    <li
      id={optionId(profile.code)}
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      // mousedown default is suppressed so clicking an option does not steal
      // focus from the search field mid-typing.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onToggle(profile.code)}
      className={cn(
        "flex cursor-pointer items-center gap-3 border-b border-[var(--border-subtle)] px-5 py-2.5 last:border-b-0",
        "transition-colors duration-100",
        active && "bg-[var(--surface-3)]",
        !active && selected && "bg-[color-mix(in_oklch,var(--color-accent-500)_8%,transparent)]",
        !active && !selected && "hover:bg-[var(--surface-2)]",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid h-4 w-4 shrink-0 place-items-center rounded-[var(--radius-xs)] border transition-colors",
          selected
            ? "border-[var(--color-accent-500)] bg-[var(--color-accent-500)]"
            : "border-[var(--border-strong)] bg-transparent",
        )}
      >
        {selected && (
          <svg viewBox="0 0 12 12" className="h-2.5 w-2.5 text-white" fill="none">
            <path
              d="m2.5 6.3 2.3 2.3 4.7-5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>

      <span className="w-14 shrink-0 font-[family-name:var(--font-mono)] text-[12px] text-[var(--color-accent-400)]">
        {profile.code}
      </span>

      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-primary)]">
        {profile.nativeName}
        <span className="ml-2 text-[var(--text-tertiary)]">{profile.name}</span>
      </span>

      {tags.map((tag) => (
        <span
          key={tag}
          className="hidden shrink-0 text-[11px] text-[var(--text-tertiary)] sm:inline"
        >
          {tag}
        </span>
      ))}

      <span className={cn("tabular w-[6.5rem] shrink-0 text-right text-[12px]", RISK_TEXT[risk])}>
        {formatExpansion(profile.expansion)}
      </span>
    </li>
  );
}

function SearchGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
