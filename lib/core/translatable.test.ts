import { describe, expect, it } from "vitest";
import { extractPlaceholders } from "./placeholders";
import { classifyNonTranslatable, isDoNotTranslate } from "./translatable";

const classify = (value: string) =>
  classifyNonTranslatable(value, extractPlaceholders(value));

describe("classifyNonTranslatable", () => {
  it("flags empty and whitespace-only values", () => {
    expect(classify("")).toBe("empty");
    expect(classify("   ")).toBe("empty");
    expect(classify("\n\t ")).toBe("empty");
  });

  it("flags URLs and bare domains", () => {
    expect(classify("https://lingoloop.dev/docs")).toBe("url");
    expect(classify("http://localhost:3000")).toBe("url");
    expect(classify("//cdn.example.com/a.png")).toBe("url");
    expect(classify("mailto:hi@example.com")).toBe("url");
    expect(classify("www.example.com")).toBe("url");
  });

  it("flags emails, numbers, dates, colours and versions", () => {
    expect(classify("support@example.com")).toBe("email");
    expect(classify("42")).toBe("number");
    expect(classify("-3.5")).toBe("number");
    expect(classify("2024-01-31")).toBe("iso-date");
    expect(classify("2024-01-31T10:00:00Z")).toBe("iso-date");
    expect(classify("#ff0055")).toBe("hex-color");
    expect(classify("#FFF")).toBe("hex-color");
    expect(classify("1.2.3")).toBe("semver");
    expect(classify("v2.0.0-beta.1")).toBe("semver");
  });

  it("flags file paths and asset names", () => {
    expect(classify("/assets/ui/icon.svg")).toBe("file-path");
    expect(classify("./locales/en.json")).toBe("file-path");
    expect(classify("assets/ui/button.png")).toBe("file-path");
    expect(classify("sprite.png")).toBe("file-path");
    expect(classify("README.md")).toBe("file-path");
  });

  it("flags machine identifiers", () => {
    expect(classify("user_display_name")).toBe("identifier");
    expect(classify("MAX_PLAYERS")).toBe("identifier");
    expect(classify("text-align-center")).toBe("identifier");
    expect(classify("com.example.app")).toBe("identifier");
  });

  it("flags strings made entirely of placeholders", () => {
    expect(classify("{{first}} {{last}}")).toBe("placeholder-only");
    expect(classify("%s")).toBe("placeholder-only");
    expect(classify("{0} - {1}")).toBeNull();
  });

  it("keeps real copy translatable", () => {
    expect(classify("Save")).toBeNull();
    expect(classify("Visit https://example.com for details")).toBeNull();
    expect(classify("Node.js")).toBeNull();
    expect(classify("Sign-up")).toBeNull();
    expect(classify("Co-op")).toBeNull();
    expect(classify("e-mail")).toBeNull();
    expect(classify("Hello {name}")).toBeNull();
    expect(classify("Version 1.2.3 is available")).toBeNull();
    expect(classify("5 min")).toBeNull();
  });

  it("isDoNotTranslate mirrors the classifier", () => {
    expect(isDoNotTranslate("", [])).toBe(true);
    expect(isDoNotTranslate("Save", [])).toBe(false);
  });
});
