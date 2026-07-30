/**
 * CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320) — the checksum every
 * ZIP local file header and central directory entry carries.
 *
 * Written by hand rather than pulled from a package: the whole export path is
 * dependency-free by design, and this is thirty lines of table lookup.
 */

/**
 * The reflected CRC table, generated once on first use.
 *
 * Built lazily so importing this module from a client bundle costs nothing
 * until an export actually runs.
 */
let table: Uint32Array | null = null;

export function crcTable(): Uint32Array {
  if (table !== null) return table;

  const next = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      // Reflected form: shift right, xor the polynomial when the low bit is set.
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    next[n] = c >>> 0;
  }
  table = next;
  return table;
}

/** CRC-32 of `bytes`, as an unsigned 32-bit integer. */
export function crc32(bytes: Uint8Array): number {
  const t = crcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    // `bytes[i]` is always in range; the index guard satisfies
    // noUncheckedIndexedAccess without a cast.
    const byte = bytes[i] ?? 0;
    crc = (t[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
