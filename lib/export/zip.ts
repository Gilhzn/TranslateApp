/**
 * A STORE-only ZIP writer and reader.
 *
 * "One click, all locales" needs an archive, and an archive needs exactly three
 * record types. Locale catalogs are small JSON files; DEFLATE would add a
 * compressor for a saving nobody downloads twice, so entries are stored
 * uncompressed (method 0). Everything a consumer needs — CRC-32, sizes, the
 * central directory and the end-of-central-directory record — is written in
 * full, so the output opens in Finder, Explorer, `unzip`, and every library.
 *
 * Not implemented on purpose: compression, ZIP64, encryption, data descriptors.
 * Any input that would require them is rejected loudly rather than emitted in a
 * form a reader might mis-parse.
 */

import type { ExportFile } from "@/lib/types";
import { crc32 } from "./crc32";

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;

/** Method 0 — stored, no compression. */
const METHOD_STORE = 0;
/** Bit 11: filenames and comments are UTF-8. */
const FLAG_UTF8 = 0x0800;
/** PKZIP 2.0 — the minimum that understands a stored entry with this layout. */
const VERSION_NEEDED = 20;
/** Upper byte 3 = UNIX, lower byte = PKZIP 2.0. */
const VERSION_MADE_BY = 0x0314;
/** `0o100644 << 16` — a regular file, rw-r--r--, in the UNIX attribute space. */
const EXTERNAL_ATTRS_FILE = 0x81a40000;

const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

export interface ZipOptions {
  /**
   * Modification timestamp stamped on every entry. Defaults to "now"; pass a
   * fixed date when byte-for-byte reproducible archives matter (tests do).
   */
  modifiedAt?: Date;
}

/** One entry as read back out of an archive. */
export interface ZipEntry extends ExportFile {
  /** Uncompressed size in bytes. */
  size: number;
  crc32: number;
  /** Modification time recovered from the DOS date/time fields. */
  modifiedAt: Date;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Normalise an archive path and reject anything a reader could resolve outside
 * the extraction directory (the "zip slip" class of bug).
 */
export function normalizeZipPath(path: string): string {
  const unified = path.replace(/\\/g, "/");
  const segments = unified.split("/").filter((s) => s.length > 0 && s !== ".");

  if (segments.length === 0) {
    throw new ZipError(`Archive entry has an empty path: ${JSON.stringify(path)}`);
  }
  if (segments.some((s) => s === "..")) {
    throw new ZipError(
      `Archive entry path escapes the archive root: ${JSON.stringify(path)}`,
    );
  }
  if (unified.includes("\u0000")) {
    throw new ZipError(
      `Archive entry path contains a NUL byte: ${JSON.stringify(path)}`,
    );
  }
  if (/^[A-Za-z]:/.test(unified)) {
    throw new ZipError(
      `Archive entry path must be relative, not a drive path: ${JSON.stringify(path)}`,
    );
  }
  return segments.join("/");
}

/**
 * Build a ZIP archive from in-memory text files.
 *
 * Entries keep the order they were given, which is the order a viewer lists
 * them in — so `de.json` before `ja.json` is the caller's decision, not a
 * side effect of hashing.
 */
export function buildZip(
  files: readonly ExportFile[],
  options: ZipOptions = {},
): Uint8Array {
  if (files.length > MAX_UINT16) {
    throw new ZipError(
      `A ZIP without ZIP64 holds at most ${MAX_UINT16} entries; got ${files.length}.`,
    );
  }

  const { date, time } = toDosDateTime(options.modifiedAt ?? new Date());

  interface Prepared {
    nameBytes: Uint8Array;
    data: Uint8Array;
    crc: number;
    offset: number;
  }

  const prepared: Prepared[] = [];
  const seen = new Set<string>();
  let offset = 0;

  for (const file of files) {
    const path = normalizeZipPath(file.path);
    if (seen.has(path)) {
      // Duplicates are legal in the format and a disaster in practice: the
      // extractor silently keeps one of them.
      throw new ZipError(`Duplicate archive entry: ${path}`);
    }
    seen.add(path);

    const nameBytes = encoder.encode(path);
    if (nameBytes.length > MAX_UINT16) {
      throw new ZipError(`Archive entry name is too long: ${path}`);
    }
    const data = encoder.encode(file.contents);
    if (data.length > MAX_UINT32) {
      throw new ZipError(
        `Archive entry ${path} is ${data.length} bytes; ZIP64 would be required.`,
      );
    }
    if (offset > MAX_UINT32) {
      throw new ZipError("Archive exceeds 4 GiB; ZIP64 would be required.");
    }

    prepared.push({ nameBytes, data, crc: crc32(data), offset });
    offset += LOCAL_HEADER_SIZE + nameBytes.length + data.length;
  }

  const centralSize = prepared.reduce(
    (sum, entry) => sum + CENTRAL_HEADER_SIZE + entry.nameBytes.length,
    0,
  );
  const total = offset + centralSize + EOCD_SIZE;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const w = new Writer(out, view);

  for (const entry of prepared) {
    w.u32(LOCAL_HEADER_SIGNATURE);
    w.u16(VERSION_NEEDED);
    w.u16(FLAG_UTF8);
    w.u16(METHOD_STORE);
    w.u16(time);
    w.u16(date);
    w.u32(entry.crc);
    w.u32(entry.data.length); // compressed === uncompressed for STORE
    w.u32(entry.data.length);
    w.u16(entry.nameBytes.length);
    w.u16(0); // extra field length
    w.bytes(entry.nameBytes);
    w.bytes(entry.data);
  }

  const centralOffset = w.position;

  for (const entry of prepared) {
    w.u32(CENTRAL_HEADER_SIGNATURE);
    w.u16(VERSION_MADE_BY);
    w.u16(VERSION_NEEDED);
    w.u16(FLAG_UTF8);
    w.u16(METHOD_STORE);
    w.u16(time);
    w.u16(date);
    w.u32(entry.crc);
    w.u32(entry.data.length);
    w.u32(entry.data.length);
    w.u16(entry.nameBytes.length);
    w.u16(0); // extra field length
    w.u16(0); // comment length
    w.u16(0); // disk number start
    w.u16(0); // internal attributes — 0, treat as binary
    w.u32(EXTERNAL_ATTRS_FILE);
    w.u32(entry.offset);
    w.bytes(entry.nameBytes);
  }

  w.u32(EOCD_SIGNATURE);
  w.u16(0); // this disk
  w.u16(0); // disk with the central directory
  w.u16(prepared.length);
  w.u16(prepared.length);
  w.u32(centralSize);
  w.u32(centralOffset);
  w.u16(0); // archive comment length

  return out;
}

/**
 * Read an archive produced by {@link buildZip} back into files.
 *
 * This exists so the writer can be verified by round trip rather than by
 * eyeballing hex, and so the UI can offer "verify this download" without a
 * dependency. It reads the central directory (the authoritative index),
 * cross-checks each local header, and verifies every CRC.
 */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view, bytes.byteLength);

  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);

  if (centralOffset + centralSize > bytes.byteLength) {
    throw new ZipError("Central directory extends past the end of the archive.");
  }

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;

  for (let i = 0; i < count; i++) {
    if (cursor + CENTRAL_HEADER_SIZE > bytes.byteLength) {
      throw new ZipError("Truncated central directory.");
    }
    if (view.getUint32(cursor, true) !== CENTRAL_HEADER_SIGNATURE) {
      throw new ZipError(`Bad central directory signature at offset ${cursor}.`);
    }

    const method = view.getUint16(cursor + 10, true);
    if (method !== METHOD_STORE) {
      throw new ZipError(
        `Entry uses compression method ${method}; only STORE (0) is supported.`,
      );
    }

    const time = view.getUint16(cursor + 12, true);
    const date = view.getUint16(cursor + 14, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);

    if (compressedSize !== size) {
      throw new ZipError("Stored entry reports mismatched sizes.");
    }

    const nameStart = cursor + CENTRAL_HEADER_SIZE;
    const path = decodeUtf8(bytes.subarray(nameStart, nameStart + nameLength));

    if (localOffset + LOCAL_HEADER_SIZE > bytes.byteLength) {
      throw new ZipError(`Local header for ${path} is out of range.`);
    }
    if (view.getUint32(localOffset, true) !== LOCAL_HEADER_SIGNATURE) {
      throw new ZipError(`Bad local header signature for ${path}.`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart =
      localOffset + LOCAL_HEADER_SIZE + localNameLength + localExtraLength;
    if (dataStart + size > bytes.byteLength) {
      throw new ZipError(`Entry data for ${path} is out of range.`);
    }

    const data = bytes.subarray(dataStart, dataStart + size);
    const actual = crc32(data);
    if (actual !== crc) {
      throw new ZipError(
        `CRC mismatch for ${path}: header says ${crc}, data hashes to ${actual}.`,
      );
    }

    entries.push({
      path,
      contents: decodeUtf8(data),
      size,
      crc32: crc,
      modifiedAt: fromDosDateTime(date, time),
    });

    cursor = nameStart + nameLength + extraLength + commentLength;
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

class Writer {
  position = 0;

  constructor(
    private readonly out: Uint8Array,
    private readonly view: DataView,
  ) {}

  u16(value: number): void {
    this.view.setUint16(this.position, value, true);
    this.position += 2;
  }

  u32(value: number): void {
    this.view.setUint32(this.position, value >>> 0, true);
    this.position += 4;
  }

  bytes(value: Uint8Array): void {
    this.out.set(value, this.position);
    this.position += value.length;
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new ZipError("Archive contains a name or payload that is not UTF-8.");
  }
}

function findEocd(view: DataView, length: number): number {
  if (length < EOCD_SIZE) throw new ZipError("Archive is too small to be a ZIP.");
  // The record is last, but a trailing comment may follow it; the comment is
  // capped at 64 KiB so the scan window is bounded.
  const earliest = Math.max(0, length - EOCD_SIZE - MAX_UINT16);
  for (let i = length - EOCD_SIZE; i >= earliest; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  throw new ZipError("No end-of-central-directory record found.");
}

/**
 * MS-DOS date/time: two-second resolution, epoch 1980. Anything earlier is
 * unrepresentable, so it clamps rather than wrapping into a garbage year.
 */
export function toDosDateTime(when: Date): { date: number; time: number } {
  const stamp = Number.isNaN(when.getTime()) ? new Date() : when;
  const year = Math.max(1980, stamp.getFullYear());
  const date =
    ((year - 1980) << 9) | ((stamp.getMonth() + 1) << 5) | stamp.getDate();
  const time =
    (stamp.getHours() << 11) |
    (stamp.getMinutes() << 5) |
    (stamp.getSeconds() >> 1);
  return { date: date & MAX_UINT16, time: time & MAX_UINT16 };
}

export function fromDosDateTime(date: number, time: number): Date {
  return new Date(
    1980 + ((date >> 9) & 0x7f),
    Math.max(0, ((date >> 5) & 0x0f) - 1),
    Math.max(1, date & 0x1f),
    (time >> 11) & 0x1f,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  );
}
