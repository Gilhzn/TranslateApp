/**
 * Read-only derivations over a parsed catalog, for the "what we understood"
 * panel. All pure — the panel is the trust surface, so every number in it is
 * computed here and unit-tested rather than assembled inline in JSX.
 */

import type {
  AmbiguityKind,
  Placeholder,
  SourceCatalog,
  StringEntry,
  UiRole,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const ROLE_LABELS: Readonly<Record<UiRole, string>> = Object.freeze({
  button: "Buttons",
  menu: "Menu items",
  label: "Field labels",
  placeholder: "Input hints",
  tooltip: "Tooltips",
  title: "Titles",
  heading: "Headings",
  body: "Body copy",
  error: "Errors",
  toast: "Toasts",
  badge: "Badges",
  unknown: "Unclassified",
});

/** Fixed display order — the tightest chrome first, prose last. */
export const ROLE_ORDER: readonly UiRole[] = [
  "button",
  "menu",
  "badge",
  "label",
  "title",
  "heading",
  "toast",
  "placeholder",
  "tooltip",
  "error",
  "body",
  "unknown",
];

export interface AmbiguityKindMeta {
  label: string;
  blurb: string;
}

export const AMBIGUITY_META: Readonly<Record<AmbiguityKind, AmbiguityKindMeta>> =
  Object.freeze({
    "verb-or-noun": {
      label: "Verb or noun",
      blurb:
        "The same English word is both an action and a thing. The UI role decides which one the target language gets.",
    },
    "action-or-state": {
      label: "Action or state",
      blurb:
        "A control label and a status message read identically in English but never in German, French or Japanese.",
    },
    homonym: {
      label: "Homonym",
      blurb: "Two unrelated meanings share one spelling. Context picks the sense.",
    },
    "unit-or-word": {
      label: "Unit or word",
      blurb: "An abbreviation that is also a word — expanding it wrongly changes the meaning.",
    },
    "brand-term": {
      label: "Brand term",
      blurb: "Product or feature naming. Carried through untranslated unless the glossary says otherwise.",
    },
    "gaming-slang": {
      label: "Gaming slang",
      blurb:
        "Community vocabulary. Most player communities keep the English word — a dictionary translation reads wrong to them.",
    },
    "tech-term": {
      label: "Technical term",
      blurb:
        "A developer term of art. Working developers in most locales say the English word; the native calque sounds machine-made.",
    },
  });

/** Display order: the kinds that most often produce a wrong string come first. */
export const AMBIGUITY_ORDER: readonly AmbiguityKind[] = [
  "action-or-state",
  "verb-or-noun",
  "homonym",
  "unit-or-word",
  "tech-term",
  "gaming-slang",
  "brand-term",
];

// ---------------------------------------------------------------------------
// Role distribution
// ---------------------------------------------------------------------------

export interface RoleTally {
  role: UiRole;
  count: number;
  /** 0..1 of the translatable population. */
  share: number;
}

/**
 * Distribution over translatable entries only. Do-not-translate values have a
 * role too, but counting them would inflate `unknown` with URLs and tokens.
 */
export function tallyRoles(entries: readonly StringEntry[]): RoleTally[] {
  const counts = new Map<UiRole, number>();
  let total = 0;
  for (const entry of entries) {
    if (entry.doNotTranslate) continue;
    counts.set(entry.role, (counts.get(entry.role) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) return [];

  const out: RoleTally[] = [];
  for (const role of ROLE_ORDER) {
    const count = counts.get(role);
    if (count === undefined || count === 0) continue;
    out.push({ role, count, share: count / total });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ambiguities
// ---------------------------------------------------------------------------

export interface AmbiguityItem {
  key: string;
  value: string;
  role: UiRole;
  note: string;
  confidence: number;
}

export interface AmbiguityGroup {
  kind: AmbiguityKind;
  count: number;
  /** Highest-confidence members, capped for display. */
  items: AmbiguityItem[];
  /** How many members are not in `items`. */
  overflow: number;
}

export interface GroupAmbiguitiesOptions {
  /** Max items rendered per group. Default 4. */
  perGroup?: number;
}

export function groupAmbiguities(
  entries: readonly StringEntry[],
  options: GroupAmbiguitiesOptions = {},
): AmbiguityGroup[] {
  const perGroup = Math.max(1, options.perGroup ?? 4);
  const buckets = new Map<AmbiguityKind, AmbiguityItem[]>();

  for (const entry of entries) {
    if (entry.doNotTranslate) continue;
    for (const flag of entry.ambiguities) {
      const bucket = buckets.get(flag.kind) ?? [];
      bucket.push({
        key: entry.key,
        value: entry.value,
        role: entry.role,
        note: flag.note,
        confidence: flag.confidence,
      });
      buckets.set(flag.kind, bucket);
    }
  }

  const out: AmbiguityGroup[] = [];
  for (const kind of AMBIGUITY_ORDER) {
    const bucket = buckets.get(kind);
    if (bucket === undefined || bucket.length === 0) continue;
    // Stable within equal confidence: sort by key so the panel does not
    // reshuffle between renders of the same catalog.
    const sorted = [...bucket].sort(
      (a, b) => b.confidence - a.confidence || a.key.localeCompare(b.key, "en"),
    );
    out.push({
      kind,
      count: sorted.length,
      items: sorted.slice(0, perGroup),
      overflow: Math.max(0, sorted.length - perGroup),
    });
  }
  return out;
}

export function totalAmbiguities(groups: readonly AmbiguityGroup[]): number {
  let total = 0;
  for (const group of groups) total += group.count;
  return total;
}

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

/**
 * A representative slice: one entry per distinct role first (so the reader sees
 * that roles were actually inferred), then the longest remaining strings, which
 * are the ones most likely to overflow.
 */
export function pickSamples(
  entries: readonly StringEntry[],
  limit: number,
): StringEntry[] {
  if (limit <= 0) return [];
  const translatable = entries.filter((entry) => !entry.doNotTranslate);
  const picked: StringEntry[] = [];
  const seenRoles = new Set<UiRole>();
  const takenKeys = new Set<string>();

  for (const role of ROLE_ORDER) {
    if (picked.length >= limit) break;
    if (seenRoles.has(role)) continue;
    const match = translatable.find(
      (entry) => entry.role === role && !takenKeys.has(entry.key),
    );
    if (match === undefined) continue;
    seenRoles.add(role);
    takenKeys.add(match.key);
    picked.push(match);
  }

  if (picked.length < limit) {
    const rest = translatable
      .filter((entry) => !takenKeys.has(entry.key))
      .sort((a, b) => b.value.length - a.value.length || a.key.localeCompare(b.key, "en"));
    for (const entry of rest) {
      if (picked.length >= limit) break;
      picked.push(entry);
    }
  }

  return picked;
}

// ---------------------------------------------------------------------------
// Placeholder highlighting
// ---------------------------------------------------------------------------

export interface ValueSegment {
  text: string;
  placeholder: boolean;
}

/**
 * Split a source string into literal and placeholder runs so the UI can tint
 * the tokens that must survive verbatim.
 *
 * Placeholders are sorted by index and overlapping ones are dropped: nested ICU
 * (`{count, plural, ...}`) yields both an outer and inner match, and rendering
 * both would duplicate text.
 */
export function segmentPlaceholders(
  value: string,
  placeholders: readonly Placeholder[],
): ValueSegment[] {
  if (placeholders.length === 0) {
    return value.length > 0 ? [{ text: value, placeholder: false }] : [];
  }

  const sorted = [...placeholders].sort((a, b) => a.index - b.index || b.raw.length - a.raw.length);
  const segments: ValueSegment[] = [];
  let cursor = 0;

  for (const placeholder of sorted) {
    const start = placeholder.index;
    const end = start + placeholder.raw.length;
    if (start < cursor || start < 0 || end > value.length) continue;
    // Guard against an index that no longer matches the text it describes.
    if (value.slice(start, end) !== placeholder.raw) continue;
    if (start > cursor) {
      segments.push({ text: value.slice(cursor, start), placeholder: false });
    }
    segments.push({ text: placeholder.raw, placeholder: true });
    cursor = end;
  }

  if (cursor < value.length) {
    segments.push({ text: value.slice(cursor), placeholder: false });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Headline figures
// ---------------------------------------------------------------------------

export interface CatalogHeadline {
  label: string;
  value: string;
  hint: string;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

export function catalogHeadlines(catalog: SourceCatalog): CatalogHeadline[] {
  const { stats } = catalog;
  const withPlaceholders = catalog.entries.reduce(
    (total, entry) =>
      !entry.doNotTranslate && entry.placeholders.length > 0 ? total + 1 : total,
    0,
  );

  return [
    {
      label: "Total keys",
      value: formatCount(stats.totalKeys),
      hint: "Every leaf in the file, strings and non-strings alike.",
    },
    {
      label: "Translatable",
      value: formatCount(stats.translatableKeys),
      hint: "Strings that will be sent to the model.",
    },
    {
      label: "Skipped",
      value: formatCount(stats.skippedKeys),
      hint: "Metadata, numbers, booleans, URLs and tokens — copied through verbatim.",
    },
    {
      label: "Characters",
      value: formatCount(stats.totalCharacters),
      hint: "Translatable characters. Drives cost and run time.",
    },
    {
      label: "Max depth",
      value: formatCount(stats.maxDepth),
      hint: "Deepest nesting level. Rebuilt exactly on export.",
    },
    {
      label: "With placeholders",
      value: formatCount(withPlaceholders),
      hint: "Strings carrying tokens that must survive byte-for-byte.",
    },
  ];
}

/** Short, honest description of the file's on-disk formatting. */
export function describeFormatting(catalog: SourceCatalog): string {
  const indent =
    catalog.indent.length === 0
      ? "minified"
      : catalog.indent.includes("\t")
        ? `${catalog.indent.length === 1 ? "tab" : `${catalog.indent.length} tabs`} indent`
        : `${catalog.indent.length}-space indent`;
  const newline = catalog.trailingNewline ? "trailing newline" : "no trailing newline";
  return `${indent} · ${newline}`;
}
