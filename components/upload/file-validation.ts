/**
 * Pre-parse gatekeeping for the drop zone.
 *
 * Kept free of React and DOM types so it can be unit-tested in the node
 * environment and reused by the paste path, the drop path and the file picker
 * without three copies of the same rules.
 */

import { JsonParseError } from "@/lib/core";

/** Hard ceiling. A locale catalog above this is a monorepo dump, not a file. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export const ACCEPTED_EXTENSIONS: readonly string[] = [".json"];

export type UploadFailureCode =
  | "extension"
  | "too-large"
  | "empty-file"
  | "invalid-json"
  | "read-error";

export interface UploadFailure {
  code: UploadFailureCode;
  /** One line, shown in bold. Names the file wherever possible. */
  title: string;
  /** One or two sentences telling the developer what to actually do. */
  detail: string;
  /**
   * Verbatim caret excerpt from {@link JsonParseError}. Rendered in a mono
   * block — never flattened into `detail`, because the alignment is the value.
   */
  snippet?: string;
  /** "line 12, column 5" when the parser knew; omitted otherwise. */
  location?: string;
}

/** Lowercased final extension including the dot, or "" when there is none. */
export function fileExtension(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot).toLowerCase();
}

const BYTE_UNITS: readonly string[] = ["B", "KB", "MB", "GB"];

/** Human byte size with one decimal above 1 KB — "812 B", "4.7 KB", "5.0 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const label = BYTE_UNITS[unit] ?? "B";
  return unit === 0 ? `${Math.round(value)} ${label}` : `${value.toFixed(1)} ${label}`;
}

export interface UploadCandidate {
  name: string;
  size: number;
}

/**
 * Everything that can be judged before reading a byte of content.
 * Returns `null` when the file is worth parsing.
 */
export function validateUploadFile(file: UploadCandidate): UploadFailure | null {
  const extension = fileExtension(file.name);

  if (!ACCEPTED_EXTENSIONS.includes(extension)) {
    return {
      code: "extension",
      title: `${file.name} is not a .json file`,
      detail:
        extension.length > 0
          ? `LingoLoop reads JSON locale catalogs, and this one is ${extension}. Export your strings as .json first — .po, .xliff, .strings, .yaml and .csv are not supported yet.`
          : "LingoLoop reads JSON locale catalogs. This file has no extension, so rename it to end in .json if it really is one.",
    };
  }

  if (file.size <= 0) {
    return {
      code: "empty-file",
      title: `${file.name} is empty`,
      detail:
        "There are no bytes to read. Check that the export finished, then drop the file again.",
    };
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      code: "too-large",
      title: `${file.name} is ${formatBytes(file.size)} — the limit is ${formatBytes(MAX_UPLOAD_BYTES)}`,
      detail:
        "Split the catalog by namespace (common.json, game.json, errors.json) and run them one at a time. Smaller files also give the model tighter sibling context, which improves the translations.",
    };
  }

  return null;
}

/** Byte length of a pasted string, without allocating a Blob. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The same size ceiling, applied to a clipboard payload. */
export function validatePastedText(text: string): UploadFailure | null {
  const bytes = utf8ByteLength(text);
  if (bytes === 0) {
    return {
      code: "empty-file",
      title: "Nothing was pasted",
      detail: "The clipboard held no text. Copy the contents of your locale file and try again.",
    };
  }
  if (bytes > MAX_UPLOAD_BYTES) {
    return {
      code: "too-large",
      title: `That paste is ${formatBytes(bytes)} — the limit is ${formatBytes(MAX_UPLOAD_BYTES)}`,
      detail:
        "Save it as a .json file and drop it in instead, or split the catalog by namespace.",
    };
  }
  return null;
}

/**
 * A clipboard payload is only intercepted when it plausibly *is* a catalog.
 * Without this the drop zone would swallow every stray copy-paste on the page.
 */
export function looksLikeJsonObject(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

/**
 * Surface the parser's own diagnostics rather than re-describing them.
 * `JsonParseError.snippet` already carries the gutter, the offending line and
 * the caret; collapsing that into a sentence is what makes most upload widgets
 * useless to debug against.
 */
export function failureFromParseError(error: JsonParseError): UploadFailure {
  const failure: UploadFailure = {
    code: "invalid-json",
    title: `${error.fileName} could not be parsed`,
    detail: error.reason,
  };
  if (error.line !== null && error.column !== null) {
    failure.location = `line ${error.line}, column ${error.column}`;
  }
  if (error.snippet.length > 0) failure.snippet = error.snippet;
  return failure;
}

/** Fallback for anything the parser did not raise itself (I/O, decode). */
export function failureFromUnknown(error: unknown, fileName: string): UploadFailure {
  if (error instanceof JsonParseError) return failureFromParseError(error);
  const reason =
    error instanceof Error && error.message.length > 0
      ? error.message
      : "The file could not be read.";
  return {
    code: "read-error",
    title: `${fileName} could not be read`,
    detail: `${reason} If the file lives on a network drive or in a sync folder, copy it locally and try again.`,
  };
}
