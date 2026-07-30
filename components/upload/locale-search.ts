/**
 * Search and presentation helpers for the target-locale picker.
 *
 * Expansion is surfaced in the list itself rather than discovered later in a
 * broken screenshot: the number next to "Deutsch" is the reason the developer's
 * buttons will overflow, and they should see it before they press Translate.
 */

import type { LocaleCode, LocaleProfile } from "@/lib/types";
import { LOCALE_PROFILES, isFullWidthScript } from "@/lib/layout";

/** A pragmatic starting set for a first run — the six most-requested markets. */
export const POPULAR_LOCALES: readonly LocaleCode[] = [
  "de",
  "fr",
  "es",
  "pt-BR",
  "ja",
  "zh-CN",
];

/** Strip diacritics so "francais" finds "Français". */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** Lowercased, diacritic-folded haystack: code + English name + native name. */
export function localeHaystack(profile: LocaleProfile): string {
  return fold(`${profile.code} ${profile.name} ${profile.nativeName}`);
}

/** Every whitespace-separated token must appear somewhere in the haystack. */
export function matchesLocaleQuery(profile: LocaleProfile, query: string): boolean {
  const tokens = fold(query).split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return true;
  const haystack = localeHaystack(profile);
  return tokens.every((token) => haystack.includes(token));
}

/**
 * All profiles that can be a *target*, sorted by English name.
 * The source locale is excluded — translating a file into its own language is
 * never what was meant, and offering it invites an expensive mistake.
 */
export function selectableLocales(sourceLocale: LocaleCode): LocaleProfile[] {
  const source = sourceLocale.toLowerCase();
  return Object.values(LOCALE_PROFILES)
    .filter((profile) => profile.code.toLowerCase() !== source)
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
}

export function filterLocaleProfiles(
  profiles: readonly LocaleProfile[],
  query: string,
): LocaleProfile[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [...profiles];
  return profiles.filter((profile) => matchesLocaleQuery(profile, trimmed));
}

/** "+35% avg", "−40% avg", "same length". Sign is explicit so it reads as risk. */
export function formatExpansion(expansion: number): string {
  const delta = Math.round((expansion - 1) * 100);
  if (delta === 0) return "same length";
  // U+2212 minus, not a hyphen — it aligns with the digits at UI sizes.
  return delta > 0 ? `+${delta}% avg` : `−${Math.abs(delta)}% avg`;
}

export type ExpansionRisk = "none" | "low" | "high";

/** Drives the colour of the expansion chip. */
export function expansionRisk(profile: LocaleProfile): ExpansionRisk {
  // Full-width scripts use fewer characters but each is ~an em box, so a
  // negative character-count expansion still renders wider than the source.
  if (isFullWidthScript(profile)) return "low";
  if (profile.expansion >= 1.3) return "high";
  if (profile.expansion > 1.05) return "low";
  return "none";
}

/** Short tags shown after the expansion chip — only when they matter. */
export function localeTags(profile: LocaleProfile): string[] {
  const tags: string[] = [];
  if (profile.direction === "rtl") tags.push("RTL");
  if (isFullWidthScript(profile)) tags.push("wide glyphs");
  else if (profile.noWordBreaks) tags.push("no word breaks");
  return tags;
}

/**
 * The worst expansion among the selected locales — the single number that
 * predicts whether this job will fight the layout.
 */
export function worstExpansion(codes: readonly LocaleCode[]): LocaleProfile | null {
  let worst: LocaleProfile | null = null;
  for (const code of codes) {
    const profile = LOCALE_PROFILES[code];
    if (profile === undefined) continue;
    if (worst === null || profile.expansion > worst.expansion) worst = profile;
  }
  return worst;
}

/** Resolve codes to profiles in selection order, dropping unknown codes. */
export function profilesFor(codes: readonly LocaleCode[]): LocaleProfile[] {
  const out: LocaleProfile[] = [];
  for (const code of codes) {
    const profile = LOCALE_PROFILES[code];
    if (profile !== undefined) out.push(profile);
  }
  return out;
}
