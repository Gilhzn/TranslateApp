import { describe, expect, it } from "vitest";
import { JsonParseError, parseSourceFile } from "@/lib/core";
import {
  MAX_UPLOAD_BYTES,
  failureFromParseError,
  failureFromUnknown,
  fileExtension,
  formatBytes,
  looksLikeJsonObject,
  utf8ByteLength,
  validatePastedText,
  validateUploadFile,
} from "./file-validation";

describe("fileExtension", () => {
  it("lowercases and keeps the final extension", () => {
    expect(fileExtension("en.JSON")).toBe(".json");
    expect(fileExtension("messages.en.json")).toBe(".json");
  });

  it("ignores directories", () => {
    expect(fileExtension("locales/de/common.json")).toBe(".json");
  });

  it("returns empty for dotfiles and extensionless names", () => {
    expect(fileExtension(".gitignore")).toBe("");
    expect(fileExtension("Makefile")).toBe("");
    expect(fileExtension("weird.")).toBe("");
  });
});

describe("formatBytes", () => {
  it("renders whole bytes without a decimal", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(812)).toBe("812 B");
  });

  it("renders one decimal above a kilobyte", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("treats nonsense sizes as zero", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(-10)).toBe("0 B");
  });
});

describe("validateUploadFile", () => {
  it("accepts a reasonable .json file", () => {
    expect(validateUploadFile({ name: "en.json", size: 4096 })).toBeNull();
  });

  it("rejects the wrong extension by name", () => {
    const failure = validateUploadFile({ name: "strings.po", size: 100 });
    expect(failure?.code).toBe("extension");
    expect(failure?.title).toContain("strings.po");
    expect(failure?.detail).toContain(".po");
  });

  it("rejects an extensionless file with different advice", () => {
    const failure = validateUploadFile({ name: "catalog", size: 100 });
    expect(failure?.code).toBe("extension");
    expect(failure?.detail).toContain("no extension");
  });

  it("rejects an empty file", () => {
    expect(validateUploadFile({ name: "en.json", size: 0 })?.code).toBe("empty-file");
  });

  it("rejects files over the 5 MB ceiling and states both numbers", () => {
    const failure = validateUploadFile({
      name: "en.json",
      size: MAX_UPLOAD_BYTES + 1,
    });
    expect(failure?.code).toBe("too-large");
    expect(failure?.title).toContain("5.0 MB");
  });

  it("accepts a file exactly at the ceiling", () => {
    expect(validateUploadFile({ name: "en.json", size: MAX_UPLOAD_BYTES })).toBeNull();
  });
});

describe("paste handling", () => {
  it("claims only payloads shaped like a JSON object", () => {
    expect(looksLikeJsonObject(' { "a": 1 } ')).toBe(true);
    expect(looksLikeJsonObject('["a"]')).toBe(false);
    expect(looksLikeJsonObject("some copied sentence")).toBe(false);
    expect(looksLikeJsonObject("")).toBe(false);
  });

  it("measures multi-byte characters as UTF-8 bytes", () => {
    expect(utf8ByteLength("ab")).toBe(2);
    expect(utf8ByteLength("日本")).toBe(6);
  });

  it("rejects an empty clipboard", () => {
    expect(validatePastedText("")?.code).toBe("empty-file");
  });

  it("applies the same size ceiling to pastes", () => {
    const huge = "a".repeat(MAX_UPLOAD_BYTES + 1);
    expect(validatePastedText(huge)?.code).toBe("too-large");
  });

  it("accepts an ordinary paste", () => {
    expect(validatePastedText('{"a":"b"}')).toBeNull();
  });
});

describe("failureFromParseError", () => {
  it("carries the parser's caret snippet through untouched", () => {
    let caught: unknown;
    try {
      parseSourceFile("en.json", '{\n  "a": 1,\n  "b" 2\n}\n');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JsonParseError);
    const failure = failureFromParseError(caught as JsonParseError);

    expect(failure.code).toBe("invalid-json");
    expect(failure.title).toContain("en.json");
    expect(failure.location).toMatch(/^line \d+, column \d+$/);
    expect(failure.snippet).toBeDefined();
    expect(failure.snippet).toContain("^");
    // The snippet is the parser's, not a reworded copy.
    expect(failure.snippet).toBe((caught as JsonParseError).snippet);
    expect(failure.detail).toBe((caught as JsonParseError).reason);
  });

  it("reports a non-object root without pretending to have a caret", () => {
    let caught: unknown;
    try {
      parseSourceFile("en.json", "[1, 2, 3]");
    } catch (error) {
      caught = error;
    }
    const failure = failureFromParseError(caught as JsonParseError);
    expect(failure.detail).toContain("array");
    expect(failure.snippet).toBeUndefined();
  });
});

describe("failureFromUnknown", () => {
  it("delegates to the parse-error formatter when given one", () => {
    const error = new JsonParseError({
      fileName: "en.json",
      reason: "boom",
      line: 2,
      column: 3,
      position: 9,
      snippet: "> 2 | x\n    | ^",
    });
    expect(failureFromUnknown(error, "en.json").code).toBe("invalid-json");
  });

  it("wraps I/O failures with actionable advice", () => {
    const failure = failureFromUnknown(new Error("NotReadableError"), "en.json");
    expect(failure.code).toBe("read-error");
    expect(failure.detail).toContain("NotReadableError");
  });

  it("survives a thrown non-Error", () => {
    const failure = failureFromUnknown("nope", "en.json");
    expect(failure.code).toBe("read-error");
    expect(failure.title).toContain("en.json");
  });
});
