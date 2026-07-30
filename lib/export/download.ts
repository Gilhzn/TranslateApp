/**
 * Browser download helpers.
 *
 * The only part of the export path that touches the DOM, kept apart from the
 * pure serialisers so those stay testable in Node.
 */

import type { ExportFile } from "@/lib/types";

export const JSON_MIME = "application/json;charset=utf-8";
export const ZIP_MIME = "application/zip";

export function toBlob(file: ExportFile): Blob {
  return new Blob([file.contents], { type: JSON_MIME });
}

export function toZipBlob(bytes: Uint8Array): Blob {
  // Since TypeScript 5.7 `Uint8Array` is generic over its backing buffer and
  // `BlobPart` insists on a plain `ArrayBuffer`. Every array this module
  // produces is allocated with `new Uint8Array(n)`, so the narrowing is sound.
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: ZIP_MIME });
}

/** Byte length of a UTF-8 encoded export, for the "12.4 kB" label. */
export function byteLength(contents: string): number {
  return new TextEncoder().encode(contents).length;
}

/** `12.4 kB`, `938 B` — SI units, because that is what file managers show. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(1)} kB`;
  return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
}

/**
 * Save a blob under `fileName`.
 *
 * The object URL is revoked on the next task rather than immediately: Safari
 * aborts the download if the URL disappears in the same tick as the click.
 */
export function downloadBlob(blob: Blob, fileName: string): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error(
      "downloadBlob requires a browser environment; call it from a client component.",
    );
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

/** Download one locale file. Nested paths collapse to the leaf name. */
export function downloadExportFile(file: ExportFile): void {
  const name = file.path.split("/").pop() ?? file.path;
  downloadBlob(toBlob(file), name);
}

/** Download an archive built by `buildZip`. */
export function downloadArchive(bytes: Uint8Array, fileName: string): void {
  downloadBlob(toZipBlob(bytes), fileName);
}
