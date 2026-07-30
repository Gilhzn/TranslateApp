/**
 * Repository path resolution for the sync plan.
 *
 * `localeDir` and `fileNamePattern` come straight out of a form field, and the
 * resulting string is handed to the GitHub contents API, which happily writes
 * to any path in the repository it is given. So every path is treated as
 * hostile input here: normalised, then rejected outright if it can escape the
 * repository root, address a `.git` internal, or resolve outside `localeDir`.
 *
 * Rejection is deliberate rather than sanitisation — silently rewriting
 * `../../.github/workflows/{locale}.json` into something safe would push a file
 * the developer never asked for.
 */

import { buildFileName, joinExportPath } from "@/lib/export";
import type { LocaleCode, SyncTarget } from "@/lib/types";
import { SyncPlanError } from "./errors";

/** Segments that must never appear, however they are spelled. */
const TRAVERSAL_SEGMENT = /^(?:\.|%2e){2}$/i;
const CURRENT_SEGMENT = /^(?:\.|%2e)$/i;
/** Windows drive prefix, e.g. `C:` — absolute on the developer's machine. */
const DRIVE_PREFIX = /^[A-Za-z]:/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Longest path git will accept on a conventional checkout. */
const MAX_PATH_LENGTH = 255;

export interface ResolvedLocaleFile {
  locale: LocaleCode;
  /** Repository-relative POSIX path, e.g. `public/locales/de.json`. */
  path: string;
  /** Final segment only, e.g. `de.json`. */
  fileName: string;
}

/**
 * Normalise a repository-relative path and reject anything that escapes.
 *
 * @param raw   the candidate path
 * @param label what the caller called this input, used in the error message
 */
export function assertSafeRepoPath(raw: string, label: string): string {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    throw new SyncPlanError("invalid-path", `${label} is empty.`, {
      input: raw,
    });
  }
  if (CONTROL_CHARS.test(trimmed)) {
    throw new SyncPlanError(
      "invalid-path",
      `${label} contains control characters.`,
      { input: raw },
    );
  }

  // Backslashes are separators on Windows and legal file-name characters on
  // POSIX; treating them as separators is the only reading that cannot be used
  // to smuggle `..\..` past a slash-only check.
  const unified = trimmed.replace(/\\/g, "/");

  if (unified.startsWith("/") || DRIVE_PREFIX.test(unified)) {
    throw new SyncPlanError(
      "path-traversal",
      `${label} must be relative to the repository root, but is absolute: ${JSON.stringify(raw)}.`,
      { input: raw },
    );
  }
  if (unified.startsWith("~")) {
    throw new SyncPlanError(
      "path-traversal",
      `${label} must not start with "~": ${JSON.stringify(raw)}.`,
      { input: raw },
    );
  }

  const segments: string[] = [];
  for (const segment of unified.split("/")) {
    if (segment.length === 0) continue; // collapse `a//b` and a trailing slash
    if (CURRENT_SEGMENT.test(segment)) continue;
    if (TRAVERSAL_SEGMENT.test(segment)) {
      throw new SyncPlanError(
        "path-traversal",
        `${label} must stay inside the repository, but walks up with "..": ${JSON.stringify(raw)}.`,
        { input: raw },
      );
    }
    if (segment === ".git") {
      throw new SyncPlanError(
        "path-traversal",
        `${label} must not write inside .git: ${JSON.stringify(raw)}.`,
        { input: raw },
      );
    }
    // Trailing dots and spaces are silently stripped by Windows checkouts,
    // which turns "de.json " into a different file than the one planned.
    if (/[ .]$/.test(segment)) {
      throw new SyncPlanError(
        "invalid-path",
        `${label} has a segment ending in a space or dot (${JSON.stringify(segment)}), which does not survive a Windows checkout.`,
        { input: raw },
      );
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    throw new SyncPlanError(
      "invalid-path",
      `${label} resolves to nothing: ${JSON.stringify(raw)}.`,
      { input: raw },
    );
  }

  const path = segments.join("/");
  if (path.length > MAX_PATH_LENGTH) {
    throw new SyncPlanError(
      "invalid-path",
      `${label} is ${path.length} characters long; the limit is ${MAX_PATH_LENGTH}.`,
      { input: raw },
    );
  }
  return path;
}

/**
 * Normalise `localeDir`. An empty directory means "repository root", which is
 * legitimate, so it is the one input allowed to resolve to nothing.
 */
export function normalizeLocaleDir(localeDir: string): string {
  const trimmed = localeDir.trim();
  if (trimmed.length === 0 || trimmed === "." || trimmed === "./") return "";
  return assertSafeRepoPath(trimmed, "Locale directory");
}

/**
 * Resolve one locale to its repository path.
 *
 * Substitution is delegated to the export module's `buildFileName`, so a synced
 * path and a downloaded file name are produced by exactly one implementation
 * and cannot drift apart.
 */
export function resolveLocalePath(
  target: Pick<SyncTarget, "localeDir" | "fileNamePattern">,
  locale: LocaleCode,
): ResolvedLocaleFile {
  const pattern = target.fileNamePattern.trim();
  if (pattern.length === 0) {
    throw new SyncPlanError(
      "invalid-path",
      "File name pattern is empty; expected something like {locale}.json.",
      { input: target.fileNamePattern },
    );
  }

  // Validate the pattern before substitution too: a traversal hidden in the
  // pattern would otherwise only be caught for locales whose code happens not
  // to normalise it away, which is a test that passes and a product that does not.
  assertSafeRepoPath(pattern, "File name pattern");

  let fileName: string;
  try {
    fileName = buildFileName(pattern, locale);
  } catch (cause) {
    throw new SyncPlanError(
      "invalid-path",
      `File name pattern ${JSON.stringify(target.fileNamePattern)} produced no file name for locale ${JSON.stringify(locale)}.`,
      { input: target.fileNamePattern, cause },
    );
  }

  const dir = normalizeLocaleDir(target.localeDir);
  const joined = joinExportPath(dir, fileName);
  const path = assertSafeRepoPath(joined, "Resolved locale path");

  const lastSlash = path.lastIndexOf("/");
  return {
    locale,
    path,
    fileName: lastSlash === -1 ? path : path.slice(lastSlash + 1),
  };
}

/**
 * Resolve every locale, rejecting collisions.
 *
 * A pattern with no `{locale}` token maps every locale to the same file; the
 * last write would win and quietly ship one language's strings under every
 * other language's name.
 */
export function resolveLocalePaths(
  target: Pick<SyncTarget, "localeDir" | "fileNamePattern">,
  locales: readonly LocaleCode[],
): ResolvedLocaleFile[] {
  const resolved: ResolvedLocaleFile[] = [];
  const seen = new Map<string, LocaleCode>();

  for (const locale of locales) {
    const file = resolveLocalePath(target, locale);
    const previous = seen.get(file.path);
    if (previous !== undefined) {
      throw new SyncPlanError(
        "duplicate-path",
        `Locales ${JSON.stringify(previous)} and ${JSON.stringify(locale)} both map to ${file.path}. Include {locale} in the file name pattern.`,
        { input: target.fileNamePattern },
      );
    }
    seen.set(file.path, locale);
    resolved.push(file);
  }

  return resolved;
}
