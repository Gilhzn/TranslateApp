/**
 * The editable shape behind the job form, and the pure reduction from that
 * shape to a {@link TranslationSettings} the pipeline can consume.
 *
 * The draft is deliberately *not* `TranslationSettings`: glossary rows need a
 * stable React key and a "keep verbatim" mode that the contract expresses as an
 * empty `translations` map, and half-typed rows must be representable without
 * being emitted. `buildTranslationSettings` is the single place that narrows.
 */

import type {
  GlossaryTerm,
  LocaleCode,
  ToneProfile,
  TranslationSettings,
} from "@/lib/types";
import { TONE_SPECS } from "@/lib/engine";

export const TONE_ORDER: readonly ToneProfile[] = [
  "neutral-product",
  "casual-indie",
  "gaming",
  "technical-developer",
  "formal-enterprise",
];

export interface ToneOption {
  tone: ToneProfile;
  label: string;
  summary: string;
}

/** Labels and one-liners come from the prompt engine so the UI cannot drift. */
export const TONE_OPTIONS: readonly ToneOption[] = TONE_ORDER.map((tone) => ({
  tone,
  label: TONE_SPECS[tone].label,
  summary: TONE_SPECS[tone].summary,
}));

export const MIN_REPAIR_ATTEMPTS = 0;
export const MAX_REPAIR_ATTEMPTS = 4;
export const DEFAULT_REPAIR_ATTEMPTS = 2;
export const PRODUCT_CONTEXT_LIMIT = 600;

export function clampRepairAttempts(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_REPAIR_ATTEMPTS;
  const rounded = Math.round(value);
  if (rounded < MIN_REPAIR_ATTEMPTS) return MIN_REPAIR_ATTEMPTS;
  if (rounded > MAX_REPAIR_ATTEMPTS) return MAX_REPAIR_ATTEMPTS;
  return rounded;
}

// ---------------------------------------------------------------------------
// Glossary drafts
// ---------------------------------------------------------------------------

export interface GlossaryDraft {
  /** Stable React key. Never leaves this module's output. */
  id: string;
  term: string;
  /**
   * True = emit an empty `translations` map, which the contract defines as
   * "keep verbatim". Per-locale renderings stay in the draft while the toggle
   * is on so flipping it back does not lose the developer's typing.
   */
  keepVerbatim: boolean;
  caseSensitive: boolean;
  note: string;
  translations: Record<LocaleCode, string>;
}

export function newGlossaryDraft(id: string): GlossaryDraft {
  return {
    id,
    term: "",
    keepVerbatim: true,
    caseSensitive: false,
    note: "",
    translations: {},
  };
}

/**
 * Drop incomplete rows, honour "keep verbatim", and keep only renderings for
 * locales that are actually part of this job — a forced German string is noise
 * in a run that does not include German.
 */
export function compileGlossary(
  drafts: readonly GlossaryDraft[],
  targetLocales: readonly LocaleCode[],
): GlossaryTerm[] {
  const active = new Set(targetLocales);
  const seen = new Set<string>();
  const out: GlossaryTerm[] = [];

  for (const draft of drafts) {
    const term = draft.term.trim();
    if (term.length === 0) continue;
    // Case-insensitive dedupe: two rows for "Deploy" and "deploy" would give
    // the model contradictory instructions.
    const identity = term.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);

    const translations: Record<LocaleCode, string> = {};
    if (!draft.keepVerbatim) {
      for (const [locale, rendering] of Object.entries(draft.translations)) {
        if (!active.has(locale)) continue;
        const value = rendering.trim();
        if (value.length === 0) continue;
        translations[locale] = value;
      }
    }

    const entry: GlossaryTerm = {
      term,
      translations,
      caseSensitive: draft.caseSensitive,
    };
    const note = draft.note.trim();
    if (note.length > 0) entry.note = note;
    out.push(entry);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Settings draft
// ---------------------------------------------------------------------------

export interface SettingsDraft {
  sourceLocale: LocaleCode;
  targetLocales: LocaleCode[];
  tone: ToneProfile;
  productContext: string;
  glossary: GlossaryDraft[];
  enforceLayout: boolean;
  maxRepairAttempts: number;
}

export function initialSettingsDraft(sourceLocale: LocaleCode): SettingsDraft {
  return {
    sourceLocale,
    targetLocales: [],
    tone: "neutral-product",
    productContext: "",
    glossary: [],
    enforceLayout: true,
    maxRepairAttempts: DEFAULT_REPAIR_ATTEMPTS,
  };
}

/** Order-preserving toggle, so the chip row reflects the order of selection. */
export function toggleLocale(
  selected: readonly LocaleCode[],
  code: LocaleCode,
): LocaleCode[] {
  return selected.includes(code)
    ? selected.filter((item) => item !== code)
    : [...selected, code];
}

export function buildTranslationSettings(draft: SettingsDraft): TranslationSettings {
  const source = draft.sourceLocale;
  const seen = new Set<LocaleCode>();
  const targetLocales: LocaleCode[] = [];
  for (const code of draft.targetLocales) {
    if (code === source || seen.has(code)) continue;
    seen.add(code);
    targetLocales.push(code);
  }

  return {
    sourceLocale: source,
    targetLocales,
    tone: draft.tone,
    productContext: draft.productContext.trim().slice(0, PRODUCT_CONTEXT_LIMIT),
    glossary: compileGlossary(draft.glossary, targetLocales),
    enforceLayout: draft.enforceLayout,
    maxRepairAttempts: clampRepairAttempts(draft.maxRepairAttempts),
  };
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export type BlockerCode = "no-catalog" | "no-locales" | "nothing-translatable";

export interface StartBlocker {
  code: BlockerCode;
  message: string;
}

export interface ReadinessInput {
  hasCatalog: boolean;
  translatableKeys: number;
  targetLocales: readonly LocaleCode[];
}

/** Everything standing between the developer and a runnable job, in order. */
export function startBlockers(input: ReadinessInput): StartBlocker[] {
  const blockers: StartBlocker[] = [];
  if (!input.hasCatalog) {
    blockers.push({
      code: "no-catalog",
      message: "Add a source catalog to begin.",
    });
    return blockers;
  }
  if (input.translatableKeys === 0) {
    blockers.push({
      code: "nothing-translatable",
      message:
        "This file has no translatable strings — every leaf is metadata, a number or a do-not-translate value.",
    });
  }
  if (input.targetLocales.length === 0) {
    blockers.push({
      code: "no-locales",
      message: "Choose at least one target language.",
    });
  }
  return blockers;
}

/** Unit count = translatable strings x target locales. Drives the run estimate. */
export function estimateUnits(
  translatableKeys: number,
  targetLocales: readonly LocaleCode[],
): number {
  return Math.max(0, translatableKeys) * targetLocales.length;
}
