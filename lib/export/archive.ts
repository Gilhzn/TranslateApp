/**
 * "Export everything" — every reviewed locale, serialised, validated and
 * packed into one archive.
 */

import type { ExportFile, Issue, LocaleResult } from "@/lib/types";
import { buildZip, type ZipOptions } from "./zip";
import {
  serializeLocaleResultDetailed,
  type ClippedEntry,
  type ExportCatalog,
  type ExportOptions,
} from "./serialize";

export interface LocaleArchive {
  bytes: Uint8Array;
  files: ExportFile[];
  /** Entries clipped to satisfy their layout budget, across all locales. */
  clipped: Array<ClippedEntry & { locale: string }>;
  /** `locale/key` pairs whose blank translation fell back to the source. */
  fellBack: Array<{ locale: string; key: string }>;
  /** Non-blocking findings, across all locales. */
  issues: Issue[];
}

/**
 * Serialise every locale and pack the results.
 *
 * Throws `ExportValidationError` from the first locale that fails validation:
 * a half-valid archive is worse than a refused one, because the developer
 * would commit it.
 */
export function buildLocaleArchive(
  catalog: ExportCatalog,
  results: readonly LocaleResult[],
  options: ExportOptions & ZipOptions = {},
): LocaleArchive {
  const files: ExportFile[] = [];
  const clipped: Array<ClippedEntry & { locale: string }> = [];
  const fellBack: Array<{ locale: string; key: string }> = [];
  const issues: Issue[] = [];

  for (const result of results) {
    const serialized = serializeLocaleResultDetailed(catalog, result, options);
    files.push(serialized.file);
    for (const item of serialized.clipped) {
      clipped.push({ ...item, locale: result.locale });
    }
    for (const key of serialized.fellBack) {
      fellBack.push({ locale: result.locale, key });
    }
    issues.push(...serialized.issues);
  }

  const zipOptions: ZipOptions = {};
  if (options.modifiedAt !== undefined) zipOptions.modifiedAt = options.modifiedAt;

  return { bytes: buildZip(files, zipOptions), files, clipped, fellBack, issues };
}

/**
 * Archive name derived from the uploaded file name: `en.json` from a project
 * exported to five locales becomes `en-locales.zip`.
 */
export function defaultArchiveName(sourceFileName: string): string {
  const base = sourceFileName
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/\.[^.]+$/, "");
  const stem = base === undefined || base.length === 0 ? "lingoloop" : base;
  return `${stem}-locales.zip`;
}
