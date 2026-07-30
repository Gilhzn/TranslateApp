import { describe, expect, it } from "vitest";
import { inferRole, tokenizeSegment } from "./roles";

describe("tokenizeSegment", () => {
  it("splits camelCase, snake_case, kebab-case and acronyms", () => {
    expect(tokenizeSegment("saveBtn")).toEqual(["save", "btn"]);
    expect(tokenizeSegment("save_button")).toEqual(["save", "button"]);
    expect(tokenizeSegment("save-button")).toEqual(["save", "button"]);
    expect(tokenizeSegment("ARIALabel")).toEqual(["aria", "label"]);
    expect(tokenizeSegment("h1")).toEqual(["h1"]);
  });
});

describe("inferRole", () => {
  it("reads the nearest key segment first", () => {
    expect(inferRole(["dialog", "confirm", "button"], "Yes")).toBe("button");
    expect(inferRole(["buttons", "save"], "Save")).toBe("button");
    expect(inferRole(["errors", "network", "toast"], "Offline")).toBe("toast");
  });

  it("reads the trailing word of a compound segment first", () => {
    expect(inferRole(["saveBtn"], "Save")).toBe("button");
    expect(inferRole(["buttonLabel"], "Save")).toBe("label");
  });

  it("maps the documented keyword families", () => {
    expect(inferRole(["nav", "home"], "Home")).toBe("menu");
    expect(inferRole(["settings", "tabs", "general"], "General")).toBe("menu");
    expect(inferRole(["form", "email", "tooltip"], "We never share it")).toBe(
      "tooltip",
    );
    expect(inferRole(["signup", "error"], "Password too short")).toBe("error");
    expect(inferRole(["snackbar", "copied"], "Copied")).toBe("toast");
    expect(inferRole(["profile", "name", "label"], "Full name")).toBe("label");
    expect(inferRole(["section", "pricing"], "Pricing")).toBe("heading");
    expect(inferRole(["hero", "h1"], "Ship faster")).toBe("heading");
    expect(inferRole(["plan", "badge"], "Pro")).toBe("badge");
    expect(inferRole(["page", "title"], "Dashboard")).toBe("title");
    expect(inferRole(["about", "description"], "A small studio.")).toBe("body");
  });

  it("treats a title attribute as a tooltip but a title key as a title", () => {
    expect(inferRole(["icon", "titleAttr"], "Close")).toBe("tooltip");
    expect(inferRole(["page", "title"], "Close")).toBe("title");
  });

  it("resolves input hints to placeholder text", () => {
    expect(inferRole(["form", "search", "hint"], "Search projects")).toBe(
      "placeholder",
    );
    expect(inferRole(["searchPlaceholder"], "Search…")).toBe("placeholder");
    expect(inferRole(["input", "email", "hint"], "you@example.com")).toBe(
      "placeholder",
    );
  });

  it("does not call a standalone hint a placeholder without input context", () => {
    expect(inferRole(["onboarding", "hint"], "Try the arrow keys")).toBe(
      "tooltip",
    );
  });

  it("falls back to value shape for uninformative keys", () => {
    const long =
      "LingoLoop translates your locale files and checks that nothing overflows the layout.";
    expect(inferRole(["a", "b"], long)).toBe("body");
    expect(inferRole(["x"], "Line one\nline two")).toBe("body");
    expect(inferRole(["x"], "Email address:")).toBe("label");
  });

  it("leans to the tighter budget for short Title Case values", () => {
    expect(inferRole(["x"], "Start Run")).toBe("button");
    expect(inferRole(["x"], "Save")).toBe("button");
  });

  it("returns unknown when nothing fires", () => {
    expect(inferRole(["x"], "well, maybe")).toBe("unknown");
    expect(inferRole(["misc", "thing"], "lorem ipsum dolor")).toBe("unknown");
  });

  it("ignores array indices when reading the path", () => {
    expect(inferRole(["errors", 0, "message"], "Nope")).toBe("error");
  });
});
