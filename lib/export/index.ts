/**
 * LingoLoop export — reviewed translations to downloadable bytes.
 *
 * The shape a caller normally uses:
 *
 *   1. `serializeLocaleResult(catalog, result)`   one locale, validated
 *   2. `buildLocaleArchive(catalog, results)`     every locale, zipped
 *   3. `downloadExportFile` / `downloadArchive`   hand it to the browser
 *
 * Everything except `download.ts` is pure and runs in Node, so the same code
 * backs the download button, the GitHub sync plan and the tests.
 */

export { crc32, crcTable } from "./crc32";

export {
  ZipError,
  buildZip,
  fromDosDateTime,
  normalizeZipPath,
  readZip,
  toDosDateTime,
} from "./zip";
export type { ZipEntry, ZipOptions } from "./zip";

export {
  ExportValidationError,
  buildFileName,
  joinExportPath,
  serializeAllLocales,
  serializeLocaleResult,
  serializeLocaleResultDetailed,
} from "./serialize";
export type {
  ClippedEntry,
  ExportCatalog,
  ExportOptions,
  SerializedLocale,
} from "./serialize";

export { buildLocaleArchive, defaultArchiveName } from "./archive";
export type { LocaleArchive } from "./archive";

export {
  JSON_MIME,
  ZIP_MIME,
  byteLength,
  downloadArchive,
  downloadBlob,
  downloadExportFile,
  formatBytes,
  toBlob,
  toZipBlob,
} from "./download";
