/**
 * Turning a reviewed {@link LocaleResult} into the bytes a developer downloads.
 *
 * Three promises are kept here and nowhere else:
 *
 *   1. The emitted file is structurally identical to the source — same keys,
 *      nesting, array lengths, non-string leaves, key order, indentation and
 *      line endings. That is delegated wholesale to `rebuildTree` +
 *      `serializeWithCatalogFormatting`, so the export path cannot drift from
 *      the parser's idea of the file's shape.
 *   2. Nothing that still overflows its UI budget is written. An entry whose
 *      recorded fit says "overflow" is clipped to its allowed width with
 *      placeholders preserved, rather than shipped broken with a warning.
 *   3. The bytes are validated before they are handed over. A failed validation
 *      throws; a corrupt locale file is never silently emitted.
 */

import {
  rebuildTree,
  serializeWithCatalogFormatting,
  extractPlaceholders,
  type CatalogFormatting,
} from "@/lib/core";
import { getLocaleProfile, truncateToWidth } from "@/lib/layout";
import { validateEmittedJson } from "@/lib/validate";
import type {
  ExportFile,
  Issue,
  LocaleCode,
  LocaleProfile,
  LocaleResult,
  SourceCatalog,
  TranslatedEntry,
} from "@/lib/types";

/**
 * A catalog plus the formatting facts needed to re-emit it.
 *
 * `ParsedCatalog` (what `parseSourceFile` returns) satisfies this directly; a
 * hand-built `SourceCatalog` is accepted too and falls back to LF endings and
 * the key order recorded on the tree nodes themselves.
 */
export type ExportCatalog = SourceCatalog & CatalogFormatting;

export class ExportValidationError extends Error {
  readonly issues: Issue[];
  readonly locale: LocaleCode;
  readonly path: string;

  constructor(locale: LocaleCode, path: string, issues: Issue[]) {
    const headline = issues[0]?.message ?? "unknown validation failure";
    super(
      `Refusing to export ${path}: ${issues.length} validation failure(s). ${headline}`,
    );
    this.name = "ExportValidationError";
    this.issues = issues;
    this.locale = locale;
    this.path = path;
  }
}

/** One entry the export had to shorten to keep promise #2. */
export interface ClippedEntry {
  key: string;
  before: string;
  after: string;
  /** Width the entry had to come down to, in em. */
  allowedWidth: number;
}

export interface ExportOptions {
  /**
   * File-name pattern; `{locale}`, `{lang}` and `{LOCALE}` are substituted.
   * Defaults to `"{locale}.json"`.
   */
  pattern?: string;
  /** Directory prefix, e.g. `"public/locales"`. Empty by default. */
  directory?: string;
  /**
   * Clip entries whose recorded fit still says `overflow`. On by default —
   * turning it off ships the model's output verbatim and is only appropriate
   * when the developer has explicitly accepted the overflow.
   */
  enforceLayout?: boolean;
  /** Target locale profile. Resolved from `result.locale` when omitted. */
  profile?: LocaleProfile;
}

export interface SerializedLocale {
  file: ExportFile;
  /** Entries shortened to satisfy their layout budget. */
  clipped: ClippedEntry[];
  /**
   * Entries whose translation was empty and fell back to the source string.
   * A blank UI string is a worse regression than an untranslated one.
   */
  fellBack: string[];
  /** Non-blocking findings from the emitted-bytes validation. */
  issues: Issue[];
}

const DEFAULT_PATTERN = "{locale}.json";

/**
 * Substitute a locale into a file-name pattern.
 *
 * `{locale}` is the full tag (`pt-BR`), `{lang}` the base language (`pt`) and
 * `{LOCALE}` the upper-cased tag, which some engines expect. A pattern with no
 * token at all is returned as-is: naming a single download `strings.json` is
 * legitimate, and the collision that would cause across locales is caught by
 * the archive writer rather than guessed at here.
 */
export function buildFileName(pattern: string, locale: LocaleCode): string {
  const tag = locale.trim();
  const lang = tag.split(/[-_]/)[0] ?? tag;
  const substituted = pattern
    .replace(/\{locale\}/g, tag)
    .replace(/\{lang\}/g, lang)
    .replace(/\{LOCALE\}/g, tag.toUpperCase())
    .replace(/\{locale_underscore\}/g, tag.replace(/-/g, "_"));

  const cleaned = substituted.replace(/\\/g, "/").replace(/^\/+/, "");
  if (cleaned.length === 0) {
    throw new ExportValidationError(locale, pattern, [
      {
        code: "invalid-json",
        severity: "error",
        message: `File-name pattern ${JSON.stringify(pattern)} produced an empty name.`,
      },
    ]);
  }
  return cleaned;
}

/** Join a directory prefix and a file name into an archive-relative path. */
export function joinExportPath(directory: string, fileName: string): string {
  const dir = directory.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return dir.length === 0 ? fileName : `${dir}/${fileName}`;
}

/**
 * Serialise one locale, with the full report of what had to be adjusted.
 *
 * @throws {ExportValidationError} when the emitted bytes fail validation.
 */
export function serializeLocaleResultDetailed(
  catalog: ExportCatalog,
  result: LocaleResult,
  options: ExportOptions = {},
): SerializedLocale {
  const profile = options.profile ?? getLocaleProfile(result.locale);
  const enforceLayout = options.enforceLayout ?? true;

  const translations = new Map<string, string>();
  const clipped: ClippedEntry[] = [];
  const fellBack: string[] = [];

  for (const entry of result.entries) {
    const resolved = resolveTarget(entry, profile, enforceLayout);
    translations.set(entry.key, resolved.target);
    if (resolved.clip !== null) clipped.push(resolved.clip);
    if (resolved.fellBack) fellBack.push(entry.key);
  }

  // The *source* tree is the template, never `result.tree`: that is the only
  // way a key the model never answered for keeps its source value and the
  // structure stays byte-shape identical.
  const tree = rebuildTree(catalog.tree, translations, catalog.keyOrder);
  const contents = serializeWithCatalogFormatting(catalog, tree);

  const path = joinExportPath(
    options.directory ?? "",
    buildFileName(options.pattern ?? DEFAULT_PATTERN, result.locale),
  );

  const issues = validateEmittedJson(contents, catalog.tree);
  const blocking = issues.filter((i) => i.severity === "error");
  if (blocking.length > 0) {
    throw new ExportValidationError(result.locale, path, blocking);
  }

  return {
    file: { path, contents },
    clipped,
    fellBack,
    issues,
  };
}

/**
 * Serialise one locale into a downloadable file.
 *
 * @throws {ExportValidationError} when the emitted bytes fail validation.
 */
export function serializeLocaleResult(
  catalog: ExportCatalog,
  result: LocaleResult,
  options: ExportOptions = {},
): ExportFile {
  return serializeLocaleResultDetailed(catalog, result, options).file;
}

/** Serialise every locale in a job, in the order given. */
export function serializeAllLocales(
  catalog: ExportCatalog,
  results: readonly LocaleResult[],
  options: ExportOptions = {},
): ExportFile[] {
  return results.map((result) =>
    serializeLocaleResult(catalog, result, options),
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface ResolvedTarget {
  target: string;
  clip: ClippedEntry | null;
  fellBack: boolean;
}

function resolveTarget(
  entry: TranslatedEntry,
  profile: LocaleProfile,
  enforceLayout: boolean,
): ResolvedTarget {
  // A blank translation for a non-blank source is a hole in the UI. The source
  // string is wrong in one language; a blank label is wrong in every sense.
  if (entry.target.length === 0 && entry.source.length > 0) {
    return { target: entry.source, clip: null, fellBack: true };
  }

  const fit = entry.fit;
  if (!enforceLayout || fit === null || fit.verdict !== "overflow") {
    return { target: entry.target, clip: null, fellBack: false };
  }

  // Placeholders must survive the cut intact — half a `{count}` is a rendering
  // bug in production, not a truncated word.
  const preserve = extractPlaceholders(entry.target).map((p) => p.raw);
  const truncation = truncateToWidth(entry.target, fit.allowedWidth, profile, {
    preserve,
  });
  if (!truncation.truncated) {
    return { target: entry.target, clip: null, fellBack: false };
  }

  return {
    target: truncation.text,
    clip: {
      key: entry.key,
      before: entry.target,
      after: truncation.text,
      allowedWidth: fit.allowedWidth,
    },
    fellBack: false,
  };
}
