/**
 * Test support for the engine.
 *
 * Building a `TranslationUnit` by hand means hand-computing a `LengthBudget`,
 * which is both tedious and wrong — the budget the pipeline actually produces
 * comes from `lib/layout`. These helpers assemble units the same way the
 * orchestrator does, so engine tests exercise real budgets and real widths
 * rather than invented ones.
 *
 * Not imported by production code.
 */

import { extractPlaceholders } from "@/lib/core";
import { getLocaleProfile, planLength } from "@/lib/layout";
import type {
  AmbiguityFlag,
  GlossaryTerm,
  LocaleCode,
  LocaleProfile,
  Placeholder,
  ProviderRequest,
  ToneProfile,
  TranslationUnit,
  UiRole,
} from "@/lib/types";

export interface UnitInput {
  key: string;
  source: string;
  role?: UiRole;
  /** Locale the budget is computed against. Defaults to German. */
  locale?: LocaleCode | LocaleProfile;
  placeholders?: Placeholder[];
  ambiguities?: AmbiguityFlag[];
  neighbors?: string[];
  developerNote?: string;
  repairFeedback?: string;
  previousAttempt?: string;
}

function toProfile(locale: LocaleCode | LocaleProfile | undefined): LocaleProfile {
  if (locale === undefined) return getLocaleProfile("de");
  return typeof locale === "string" ? getLocaleProfile(locale) : locale;
}

export function makeUnit(input: UnitInput): TranslationUnit {
  const profile = toProfile(input.locale);
  const role = input.role ?? "button";
  const plan = planLength(input.source, role, profile);

  const unit: TranslationUnit = {
    key: input.key,
    source: input.source,
    role,
    placeholders: input.placeholders ?? extractPlaceholders(input.source),
    ambiguities: input.ambiguities ?? [],
    budget: plan.budget,
    allowedWidth: plan.allowedWidth,
    neighbors: input.neighbors ?? [],
  };
  if (input.developerNote !== undefined) unit.developerNote = input.developerNote;
  if (input.repairFeedback !== undefined) unit.repairFeedback = input.repairFeedback;
  if (input.previousAttempt !== undefined) unit.previousAttempt = input.previousAttempt;
  return unit;
}

export interface RequestInput {
  units: TranslationUnit[];
  locale?: LocaleCode | LocaleProfile;
  sourceLocale?: LocaleCode;
  tone?: ToneProfile;
  productContext?: string;
  glossary?: GlossaryTerm[];
}

export function makeRequest(input: RequestInput): ProviderRequest {
  return {
    locale: toProfile(input.locale),
    sourceLocale: input.sourceLocale ?? "en",
    tone: input.tone ?? "neutral-product",
    productContext: input.productContext ?? "A roguelike deckbuilder for PC.",
    glossary: input.glossary ?? [],
    units: input.units,
  };
}
