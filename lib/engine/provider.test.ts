import { describe, expect, it } from "vitest";

import { AnthropicProvider } from "./anthropic";
import {
  describeActiveProvider,
  parseMode,
  readEngineEnv,
  resolveProvider,
  type EngineEnv,
} from "./provider";
import { DeterministicProvider } from "./simulation";

const WITH_KEY: EngineEnv = { ANTHROPIC_API_KEY: "sk-test" };
const WITHOUT_KEY: EngineEnv = {};

describe("parseMode", () => {
  it.each([
    ["anthropic", "anthropic"],
    ["live", "anthropic"],
    ["API", "anthropic"],
    ["deterministic", "deterministic"],
    ["offline", "deterministic"],
    ["  Simulation  ", "deterministic"],
    ["nonsense", "auto"],
    [undefined, "auto"],
  ] as const)("%s -> %s", (raw, expected) => {
    expect(parseMode(raw)).toBe(expected);
  });
});

describe("readEngineEnv", () => {
  it("returns the override untouched", () => {
    expect(readEngineEnv(WITH_KEY)).toBe(WITH_KEY);
  });

  it("reads only the three variables the engine cares about", () => {
    const env = readEngineEnv();
    expect(Object.keys(env).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "LINGOLOOP_MODEL",
      "LINGOLOOP_PROVIDER",
    ]);
  });
});

describe("resolveProvider", () => {
  it("uses Anthropic when a key is configured", () => {
    const provider = resolveProvider({ env: WITH_KEY });
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.isConfigured()).toBe(true);
  });

  it("falls back to the simulator with no key", () => {
    const provider = resolveProvider({ env: WITHOUT_KEY });
    expect(provider).toBeInstanceOf(DeterministicProvider);
    expect(provider.id).toBe("deterministic");
  });

  it("treats a blank key as no key", () => {
    expect(resolveProvider({ env: { ANTHROPIC_API_KEY: "   " } })).toBeInstanceOf(
      DeterministicProvider,
    );
  });

  it("honours an explicit option override in both directions", () => {
    expect(resolveProvider({ mode: "deterministic", env: WITH_KEY })).toBeInstanceOf(
      DeterministicProvider,
    );
    expect(resolveProvider({ mode: "anthropic", env: WITHOUT_KEY })).toBeInstanceOf(
      AnthropicProvider,
    );
  });

  it("honours LINGOLOOP_PROVIDER", () => {
    expect(
      resolveProvider({ env: { ...WITH_KEY, LINGOLOOP_PROVIDER: "offline" } }),
    ).toBeInstanceOf(DeterministicProvider);
    expect(
      resolveProvider({ env: { LINGOLOOP_PROVIDER: "anthropic" } }),
    ).toBeInstanceOf(AnthropicProvider);
  });

  it("lets an option override beat the environment variable", () => {
    expect(
      resolveProvider({
        mode: "anthropic",
        env: { ...WITH_KEY, LINGOLOOP_PROVIDER: "offline" },
      }),
    ).toBeInstanceOf(AnthropicProvider);
  });

  it("does not silently substitute the simulator when Anthropic was demanded", () => {
    const provider = resolveProvider({ mode: "anthropic", env: WITHOUT_KEY });
    expect(provider.isConfigured()).toBe(false);
  });

  it("threads the model through from the environment and from options", () => {
    const fromEnv = resolveProvider({
      env: { ...WITH_KEY, LINGOLOOP_MODEL: "claude-opus-4-5" },
    });
    expect((fromEnv as AnthropicProvider).model).toBe("claude-opus-4-5");

    const fromOptions = resolveProvider({
      env: { ...WITH_KEY, LINGOLOOP_MODEL: "claude-opus-4-5" },
      anthropic: { model: "explicit" },
    });
    expect((fromOptions as AnthropicProvider).model).toBe("explicit");
  });

  it("passes an explicit apiKey without needing the environment", () => {
    const provider = resolveProvider({
      env: WITHOUT_KEY,
      anthropic: { apiKey: "sk-explicit" },
    });
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.isConfigured()).toBe(true);
  });

  it("passes options through to the simulator", async () => {
    const slept: number[] = [];
    const provider = resolveProvider({
      env: WITHOUT_KEY,
      deterministic: {
        latencyMs: 5,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    });
    await provider.translate({
      locale: { code: "de", name: "German", nativeName: "Deutsch", expansion: 1.35, direction: "ltr", glyphWidth: 1, noWordBreaks: false },
      sourceLocale: "en",
      tone: "neutral-product",
      productContext: "",
      glossary: [],
      units: [],
    });
    expect(slept).toEqual([5]);
  });
});

describe("describeActiveProvider", () => {
  it("says plainly that simulation output is not a translation", () => {
    const description = describeActiveProvider({ env: WITHOUT_KEY });
    expect(description.mode).toBe("simulation");
    expect(description.model).toBeNull();
    expect(description.ready).toBe(true);
    expect(description.forced).toBe(false);
    expect(description.headline).toMatch(/no API key/i);
    expect(description.detail).toMatch(/not translations/i);
    expect(description.detail).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("distinguishes a forced simulation from a fallback", () => {
    const forced = describeActiveProvider({ mode: "deterministic", env: WITH_KEY });
    expect(forced.forced).toBe(true);
    expect(forced.headline).toMatch(/forced/i);
    expect(forced.detail).toMatch(/it is not a translation/i);
  });

  it("names the live model", () => {
    const description = describeActiveProvider({
      env: { ...WITH_KEY, LINGOLOOP_MODEL: "claude-opus-4-5" },
    });
    expect(description.mode).toBe("live");
    expect(description.model).toBe("claude-opus-4-5");
    expect(description.ready).toBe(true);
    expect(description.headline).toContain("claude-opus-4-5");
    expect(description.detail).toMatch(/LINGOLOOP_MODEL/);
  });

  it("warns when Anthropic was demanded but cannot run", () => {
    const description = describeActiveProvider({ mode: "anthropic", env: WITHOUT_KEY });
    expect(description.mode).toBe("live");
    expect(description.ready).toBe(false);
    expect(description.headline).toMatch(/no API key/i);
    expect(description.detail).toMatch(/every batch will fail/i);
  });

  it("agrees with resolveProvider about which provider is active", () => {
    const cases: Array<[EngineEnv, Parameters<typeof resolveProvider>[0]]> = [
      [WITH_KEY, { env: WITH_KEY }],
      [WITHOUT_KEY, { env: WITHOUT_KEY }],
      [WITH_KEY, { env: WITH_KEY, mode: "deterministic" }],
      [WITHOUT_KEY, { env: WITHOUT_KEY, mode: "anthropic" }],
      [WITHOUT_KEY, { env: { LINGOLOOP_PROVIDER: "live" } }],
    ];

    for (const [, options] of cases) {
      expect(describeActiveProvider(options).id).toBe(resolveProvider(options).id);
    }
  });
});
