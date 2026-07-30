import { describe, expect, it } from "vitest";
import type { ExportFile } from "@/lib/types";
import { crc32 } from "./crc32";
import {
  ZipError,
  buildZip,
  fromDosDateTime,
  normalizeZipPath,
  readZip,
  toDosDateTime,
} from "./zip";

const FIXED_DATE = new Date(2026, 4, 17, 13, 42, 30);

const files: ExportFile[] = [
  { path: "locales/de.json", contents: '{\n  "save": "Speichern"\n}\n' },
  { path: "locales/ja.json", contents: '{\n  "save": "保存"\n}\n' },
];

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe("normalizeZipPath", () => {
  it("collapses separators and strips leading slashes", () => {
    expect(normalizeZipPath("/locales//de.json")).toBe("locales/de.json");
    expect(normalizeZipPath("./locales/./de.json")).toBe("locales/de.json");
    expect(normalizeZipPath("locales\\de.json")).toBe("locales/de.json");
  });

  it("rejects traversal, drive paths and empty names", () => {
    expect(() => normalizeZipPath("../etc/passwd")).toThrow(ZipError);
    expect(() => normalizeZipPath("locales/../../x.json")).toThrow(ZipError);
    expect(() => normalizeZipPath("C:/locales/de.json")).toThrow(ZipError);
    expect(() => normalizeZipPath("   ".trim())).toThrow(ZipError);
    expect(() => normalizeZipPath("/")).toThrow(ZipError);
  });
});

describe("buildZip byte structure", () => {
  const zip = buildZip(files, { modifiedAt: FIXED_DATE });
  const v = view(zip);

  it("starts with a local file header", () => {
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    expect(v.getUint16(4, true)).toBe(20); // version needed
    expect(v.getUint16(6, true)).toBe(0x0800); // UTF-8 filename flag
    expect(v.getUint16(8, true)).toBe(0); // STORE
  });

  it("stores entries uncompressed with a correct CRC and matching sizes", () => {
    const first = files[0];
    if (first === undefined) throw new Error("fixture missing");
    const data = new TextEncoder().encode(first.contents);

    expect(v.getUint32(14, true)).toBe(crc32(data));
    expect(v.getUint32(18, true)).toBe(data.length); // compressed size
    expect(v.getUint32(22, true)).toBe(data.length); // uncompressed size
    expect(v.getUint16(26, true)).toBe(
      new TextEncoder().encode(first.path).length,
    );
    expect(v.getUint16(28, true)).toBe(0); // no extra field
  });

  it("ends with an end-of-central-directory record that indexes every entry", () => {
    const eocd = zip.length - 22;
    expect(v.getUint32(eocd, true)).toBe(0x06054b50);
    expect(v.getUint16(eocd + 8, true)).toBe(files.length);
    expect(v.getUint16(eocd + 10, true)).toBe(files.length);

    const centralSize = v.getUint32(eocd + 12, true);
    const centralOffset = v.getUint32(eocd + 16, true);
    expect(centralOffset + centralSize).toBe(eocd);
    expect(v.getUint32(centralOffset, true)).toBe(0x02014b50);
  });

  it("points each central directory entry at a real local header", () => {
    const eocd = zip.length - 22;
    let cursor = v.getUint32(eocd + 16, true);
    for (let i = 0; i < files.length; i++) {
      expect(v.getUint32(cursor, true)).toBe(0x02014b50);
      const localOffset = v.getUint32(cursor + 42, true);
      expect(v.getUint32(localOffset, true)).toBe(0x04034b50);
      const nameLength = v.getUint16(cursor + 28, true);
      cursor +=
        46 + nameLength + v.getUint16(cursor + 30, true) + v.getUint16(cursor + 32, true);
    }
    expect(cursor).toBe(eocd);
  });

  it("is byte-for-byte reproducible for a fixed timestamp", () => {
    expect(Array.from(buildZip(files, { modifiedAt: FIXED_DATE }))).toEqual(
      Array.from(zip),
    );
  });
});

describe("round trip", () => {
  it("reads back exactly what was written", () => {
    const zip = buildZip(files, { modifiedAt: FIXED_DATE });
    const back = readZip(zip);

    expect(back.map((f) => f.path)).toEqual(files.map((f) => f.path));
    expect(back.map((f) => f.contents)).toEqual(files.map((f) => f.contents));
    expect(back[0]?.size).toBe(
      new TextEncoder().encode(files[0]?.contents ?? "").length,
    );
  });

  it("survives non-ASCII file names and payloads", () => {
    const exotic: ExportFile[] = [
      { path: "locales/日本語.json", contents: '{"hp":"体力","emoji":"🎮"}' },
      { path: "locales/عربى.json", contents: '{"hp":"صحة"}' },
    ];
    const back = readZip(buildZip(exotic, { modifiedAt: FIXED_DATE }));
    expect(back).toHaveLength(2);
    expect(back[0]?.path).toBe("locales/日本語.json");
    expect(back[0]?.contents).toBe('{"hp":"体力","emoji":"🎮"}');
    expect(back[1]?.contents).toBe('{"hp":"صحة"}');
  });

  it("preserves the modification timestamp to DOS resolution", () => {
    const back = readZip(buildZip(files, { modifiedAt: FIXED_DATE }));
    const stamp = back[0]?.modifiedAt;
    expect(stamp?.getFullYear()).toBe(2026);
    expect(stamp?.getMonth()).toBe(4);
    expect(stamp?.getDate()).toBe(17);
    expect(stamp?.getHours()).toBe(13);
    expect(stamp?.getMinutes()).toBe(42);
    // Two-second resolution is inherent to the format.
    expect(stamp?.getSeconds()).toBe(30);
  });

  it("handles an empty file and an empty archive", () => {
    const back = readZip(buildZip([{ path: "empty.json", contents: "" }]));
    expect(back[0]?.contents).toBe("");
    expect(back[0]?.crc32).toBe(0);
    expect(readZip(buildZip([]))).toEqual([]);
  });

  it("detects a corrupted payload through the CRC", () => {
    const zip = buildZip(files, { modifiedAt: FIXED_DATE });
    // Flip a byte inside the first entry's stored data.
    const dataStart = 30 + new TextEncoder().encode(files[0]?.path ?? "").length;
    const corrupted = zip.slice();
    corrupted[dataStart + 4] = (corrupted[dataStart + 4] ?? 0) ^ 0xff;
    expect(() => readZip(corrupted)).toThrow(/CRC mismatch/);
  });

  it("rejects bytes that are not a ZIP", () => {
    expect(() => readZip(new Uint8Array(4))).toThrow(ZipError);
    expect(() =>
      readZip(new TextEncoder().encode("not a zip at all, just prose".repeat(4))),
    ).toThrow(/end-of-central-directory/);
  });
});

describe("buildZip guards", () => {
  it("refuses duplicate entry names", () => {
    expect(() =>
      buildZip([
        { path: "de.json", contents: "{}" },
        { path: "./de.json", contents: "{}" },
      ]),
    ).toThrow(/Duplicate archive entry/);
  });

  it("refuses paths that escape the archive root", () => {
    expect(() => buildZip([{ path: "../de.json", contents: "{}" }])).toThrow(
      ZipError,
    );
  });
});

describe("DOS date/time", () => {
  it("clamps dates before the 1980 epoch instead of wrapping", () => {
    const { date } = toDosDateTime(new Date(1970, 0, 1, 0, 0, 0));
    expect((date >> 9) & 0x7f).toBe(0);
    expect(fromDosDateTime(date, 0).getFullYear()).toBe(1980);
  });

  it("round-trips a representative timestamp", () => {
    const { date, time } = toDosDateTime(FIXED_DATE);
    const back = fromDosDateTime(date, time);
    expect(back.getFullYear()).toBe(FIXED_DATE.getFullYear());
    expect(back.getMonth()).toBe(FIXED_DATE.getMonth());
    expect(back.getDate()).toBe(FIXED_DATE.getDate());
    expect(back.getHours()).toBe(FIXED_DATE.getHours());
    expect(back.getMinutes()).toBe(FIXED_DATE.getMinutes());
  });

  it("falls back to a valid stamp for an invalid date", () => {
    const { date } = toDosDateTime(new Date(Number.NaN));
    expect(fromDosDateTime(date, 0).getFullYear()).toBeGreaterThanOrEqual(1980);
  });
});
