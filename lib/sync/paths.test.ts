import { describe, expect, it } from "vitest";
import { SyncPlanError } from "./errors";
import {
  assertSafeRepoPath,
  normalizeLocaleDir,
  resolveLocalePath,
  resolveLocalePaths,
} from "./paths";

const target = { localeDir: "public/locales", fileNamePattern: "{locale}.json" };

describe("resolveLocalePath", () => {
  it("maps a locale into localeDir with the pattern substituted", () => {
    expect(resolveLocalePath(target, "de")).toEqual({
      locale: "de",
      path: "public/locales/de.json",
      fileName: "de.json",
    });
  });

  it("supports the {lang}, {LOCALE} and underscore forms", () => {
    expect(
      resolveLocalePath({ ...target, fileNamePattern: "{lang}/messages.json" }, "pt-BR")
        .path,
    ).toBe("public/locales/pt/messages.json");
    expect(
      resolveLocalePath({ ...target, fileNamePattern: "{LOCALE}.json" }, "pt-BR").path,
    ).toBe("public/locales/PT-BR.json");
    expect(
      resolveLocalePath({ ...target, fileNamePattern: "{locale_underscore}.json" }, "pt-BR")
        .path,
    ).toBe("public/locales/pt_BR.json");
  });

  it("normalises separators, redundant slashes and dot segments", () => {
    expect(
      resolveLocalePath(
        { localeDir: ".\\public\\\\locales\\.\\", fileNamePattern: "{locale}.json" },
        "ja",
      ).path,
    ).toBe("public/locales/ja.json");
  });

  it("writes at the repository root when localeDir is empty", () => {
    expect(
      resolveLocalePath({ localeDir: "   ", fileNamePattern: "{locale}.json" }, "fr").path,
    ).toBe("fr.json");
  });

  it("keeps a nested pattern hierarchical", () => {
    const resolved = resolveLocalePath(
      { localeDir: "src/i18n", fileNamePattern: "{locale}/common.json" },
      "es",
    );
    expect(resolved.path).toBe("src/i18n/es/common.json");
    expect(resolved.fileName).toBe("common.json");
  });
});

describe("path traversal rejection", () => {
  const cases: Array<[string, string]> = [
    ["parent segment in the pattern", "../{locale}.json"],
    ["parent segment mid-path", "nested/../../{locale}.json"],
    ["backslash traversal", "..\\{locale}.json"],
    ["percent-encoded traversal", "%2e%2e/{locale}.json"],
    ["absolute path", "/etc/{locale}.json"],
    ["home-relative path", "~/{locale}.json"],
    ["windows drive", "C:/tmp/{locale}.json"],
    ["git internals", ".git/hooks/{locale}.json"],
  ];

  for (const [label, pattern] of cases) {
    it(`rejects ${label}`, () => {
      expect(() => resolveLocalePath({ ...target, fileNamePattern: pattern }, "de")).toThrow(
        SyncPlanError,
      );
    });
  }

  it("rejects traversal in the directory as well as the pattern", () => {
    expect(() =>
      resolveLocalePath({ localeDir: "../../.github/workflows", fileNamePattern: "{locale}.json" }, "de"),
    ).toThrowError(/repository/i);
  });

  it("rejects a locale code that tries to escape through substitution", () => {
    expect(() => resolveLocalePath(target, "../../etc/passwd")).toThrow(SyncPlanError);
  });

  it("reports a machine-readable code and the offending input", () => {
    try {
      resolveLocalePath({ ...target, fileNamePattern: "../{locale}.json" }, "de");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SyncPlanError);
      const planError = error as SyncPlanError;
      expect(planError.code).toBe("path-traversal");
      expect(planError.input).toBe("../{locale}.json");
    }
  });

  it("rejects control characters and empty patterns", () => {
    expect(() => resolveLocalePath({ ...target, fileNamePattern: "de\u0000.json" }, "de")).toThrow(
      SyncPlanError,
    );
    expect(() => resolveLocalePath({ ...target, fileNamePattern: "   " }, "de")).toThrow(
      SyncPlanError,
    );
  });

  it("rejects segments that would not survive a Windows checkout", () => {
    expect(() => assertSafeRepoPath("locales/de. /x.json", "Pattern")).toThrow(SyncPlanError);
  });

  it("rejects paths beyond the filesystem limit", () => {
    expect(() => assertSafeRepoPath(`${"a".repeat(300)}.json`, "Pattern")).toThrowError(/255/);
  });
});

describe("normalizeLocaleDir", () => {
  it("treats empty, '.' and './' as the repository root", () => {
    expect(normalizeLocaleDir("")).toBe("");
    expect(normalizeLocaleDir(".")).toBe("");
    expect(normalizeLocaleDir("./")).toBe("");
  });

  it("strips leading and trailing separators", () => {
    expect(normalizeLocaleDir("public/locales/")).toBe("public/locales");
  });
});

describe("resolveLocalePaths", () => {
  it("resolves every locale in order", () => {
    expect(resolveLocalePaths(target, ["de", "fr", "ja"]).map((f) => f.path)).toEqual([
      "public/locales/de.json",
      "public/locales/fr.json",
      "public/locales/ja.json",
    ]);
  });

  it("rejects a pattern that maps two locales onto one file", () => {
    try {
      resolveLocalePaths({ ...target, fileNamePattern: "strings.json" }, ["de", "fr"]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as SyncPlanError).code).toBe("duplicate-path");
      expect((error as SyncPlanError).message).toContain("{locale}");
    }
  });

  it("allows a single locale with a pattern that has no token", () => {
    expect(resolveLocalePaths(target, ["de"]).length).toBe(1);
    expect(
      resolveLocalePaths({ ...target, fileNamePattern: "strings.json" }, ["de"])[0]?.path,
    ).toBe("public/locales/strings.json");
  });
});
