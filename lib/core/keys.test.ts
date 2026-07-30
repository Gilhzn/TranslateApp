import { describe, expect, it } from "vitest";
import { decodeKey, encodeKey, KeyDecodeError } from "./keys";

describe("encodeKey", () => {
  it("joins object segments with dots", () => {
    expect(encodeKey(["menu", "file", "save"])).toBe("menu.file.save");
  });

  it("renders array indices as brackets", () => {
    expect(encodeKey(["errors", 0, "title"])).toBe("errors[0].title");
    expect(encodeKey([0])).toBe("[0]");
    expect(encodeKey(["a", 0, 1, "b"])).toBe("a[0][1].b");
  });

  it("escapes structural characters inside object keys", () => {
    expect(encodeKey(["app.name"])).toBe("app\\.name");
    expect(encodeKey(["items[]", "x"])).toBe("items\\[\\].x");
    expect(encodeKey(["back\\slash"])).toBe("back\\\\slash");
  });
});

describe("decodeKey", () => {
  it("is the inverse of encodeKey", () => {
    const paths: Array<Array<string | number>> = [
      ["a"],
      ["a", "b", "c"],
      ["a", 0],
      [0],
      [0, 1, 2],
      ["errors", 0, "title"],
      ["a.b", "c"],
      ["a", "b.c.d"],
      ["items[]", 3, "label"],
      ["weird]key", "x"],
      ["back\\slash", "y"],
      ["", "empty-parent"],
      ["parent", ""],
      ["emoji🎮", "ok"],
      ["0", "1"],
      ["a", 10, "b", 2],
    ];
    for (const path of paths) {
      expect(decodeKey(encodeKey(path))).toEqual(path);
    }
  });

  it("distinguishes numeric object keys from array indices", () => {
    expect(decodeKey("a.0")).toEqual(["a", "0"]);
    expect(decodeKey("a[0]")).toEqual(["a", 0]);
    expect(encodeKey(["a", "0"])).not.toBe(encodeKey(["a", 0]));
  });

  it("round-trips a key that literally contains a bracketed number", () => {
    const path = ["a[0]", "b"];
    const key = encodeKey(path);
    expect(key).toBe("a\\[0\\].b");
    expect(decodeKey(key)).toEqual(path);
  });

  it("rejects malformed keys instead of guessing", () => {
    expect(() => decodeKey("a[")).toThrow(KeyDecodeError);
    expect(() => decodeKey("a[x]")).toThrow(KeyDecodeError);
    expect(() => decodeKey("a]b")).toThrow(KeyDecodeError);
    expect(() => decodeKey("a\\")).toThrow(KeyDecodeError);
  });
});
