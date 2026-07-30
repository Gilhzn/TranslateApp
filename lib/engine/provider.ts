/**
 * Provider selection.
 *
 * One rule, and it is a product rule rather than a technical one: the developer
 * must always be able to tell, at a glance, whether the strings in front of
 * them came from a model or from the offline simulator. Silently degrading to
 * simulation and presenting the output as a translation would be the single
 * most damaging thing this tool could do, so `describeActiveProvider` exists
 * specifically to be surfaced in the UI and says so in plain language.
 */

import type { TranslationProvider } from "@/lib/types";
import {
  ANTHROPIC_PROVIDER_ID,
  AnthropicProvider,
  DEFAULT_MODEL,
  type AnthropicProviderOptions,
} from "./anthropic";
import {
  DETERMINISTIC_PROVIDER_ID,
  DeterministicProvider,
  type DeterministicProviderOptions,
} from "./simulation";

export type ProviderMode = "auto" | "anthropic" | "deterministic";

/** The subset of the environment this engine reads. */
export interface EngineEnv {
  ANTHROPIC_API_KEY?: string | undefined;
  LINGOLOOP_MODEL?: string | undefined;
  LINGOLOOP_PROVIDER?: string | undefined;
}

export interface ResolveProviderOptions {
  /**
   * Explicit override. `"auto"` (the default) picks Anthropic when a key is
   * configured and the simulator otherwise.
   */
  mode?: ProviderMode;
  /** Environment override; defaults to `process.env` where it exists. */
  env?: EngineEnv;
  anthropic?: AnthropicProviderOptions;
  deterministic?: DeterministicProviderOptions;
}

export function readEngineEnv(override?: EngineEnv): EngineEnv {
  if (override !== undefined) return override;
  if (typeof process === "undefined") return {};
  const env = process.env;
  return {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    LINGOLOOP_MODEL: env.LINGOLOOP_MODEL,
    LINGOLOOP_PROVIDER: env.LINGOLOOP_PROVIDER,
  };
}

/** Parse `LINGOLOOP_PROVIDER`; anything unrecognised means "decide for me". */
export function parseMode(raw: string | undefined): ProviderMode {
  switch (raw?.trim().toLowerCase()) {
    case "anthropic":
    case "live":
    case "api":
      return "anthropic";
    case "deterministic":
    case "simulation":
    case "offline":
    case "sim":
      return "deterministic";
    default:
      return "auto";
  }
}

function hasApiKey(env: EngineEnv, options: ResolveProviderOptions): boolean {
  const explicit = options.anthropic?.apiKey;
  if (explicit !== undefined) return explicit.length > 0;
  const fromEnv = env.ANTHROPIC_API_KEY;
  return fromEnv !== undefined && fromEnv.trim().length > 0;
}

function modelFor(env: EngineEnv, options: ResolveProviderOptions): string {
  return options.anthropic?.model ?? env.LINGOLOOP_MODEL ?? DEFAULT_MODEL;
}

/**
 * Pick a provider.
 *
 * `mode: "anthropic"` returns the live provider even when it is unconfigured —
 * the caller asked for it explicitly, and a request will come back with a clear
 * `provider-error` rather than being quietly answered by the simulator.
 */
export function resolveProvider(
  options: ResolveProviderOptions = {},
): TranslationProvider {
  const env = readEngineEnv(options.env);
  const mode =
    options.mode ?? parseMode(env.LINGOLOOP_PROVIDER);

  if (mode === "deterministic") {
    return new DeterministicProvider(options.deterministic ?? {});
  }

  const anthropicOptions: AnthropicProviderOptions = {
    ...options.anthropic,
    model: modelFor(env, options),
  };
  if (options.anthropic?.apiKey === undefined && env.ANTHROPIC_API_KEY !== undefined) {
    anthropicOptions.apiKey = env.ANTHROPIC_API_KEY;
  }

  if (mode === "anthropic") return new AnthropicProvider(anthropicOptions);

  return hasApiKey(env, options)
    ? new AnthropicProvider(anthropicOptions)
    : new DeterministicProvider(options.deterministic ?? {});
}

export interface ActiveProviderDescription {
  id: string;
  label: string;
  /** `"live"` means a real model answered; `"simulation"` means it did not. */
  mode: "live" | "simulation";
  /** Model id when live, `null` in simulation. */
  model: string | null;
  /** True when the selected provider has everything it needs to run. */
  ready: boolean;
  /** Whether an explicit override (option or env var) forced this choice. */
  forced: boolean;
  /** One line for a status pill. */
  headline: string;
  /** One or two sentences for a banner or tooltip. Always honest. */
  detail: string;
}

/**
 * What to tell the developer about the mode they are actually in.
 *
 * Consumed by the UI. Deliberately never optimistic: in simulation mode the
 * copy states outright that the output is not a translation.
 */
export function describeActiveProvider(
  options: ResolveProviderOptions = {},
): ActiveProviderDescription {
  const env = readEngineEnv(options.env);
  const requested = options.mode ?? parseMode(env.LINGOLOOP_PROVIDER);
  const forced = requested !== "auto";
  const configured = hasApiKey(env, options);
  const model = modelFor(env, options);

  const useAnthropic =
    requested === "anthropic" || (requested === "auto" && configured);

  if (!useAnthropic) {
    return {
      id: DETERMINISTIC_PROVIDER_ID,
      label: "Offline simulation",
      mode: "simulation",
      model: null,
      ready: true,
      forced,
      headline: forced
        ? "Offline simulation (forced)"
        : "Offline simulation — no API key",
      detail: forced
        ? "The provider was pinned to offline simulation. Output is deterministic pseudo-localisation that honours placeholders, the glossary and the length budgets — it is not a translation."
        : "No ANTHROPIC_API_KEY was found, so LingoLoop is running its offline simulator. Every stage of the pipeline runs for real, but the strings are deterministic pseudo-localisation, not translations. Set ANTHROPIC_API_KEY to translate for real.",
    };
  }

  return {
    id: ANTHROPIC_PROVIDER_ID,
    label: "Anthropic API",
    mode: "live",
    model,
    ready: configured,
    forced,
    headline: configured
      ? `Anthropic · ${model}`
      : `Anthropic · ${model} (no API key)`,
    detail: configured
      ? `Translating with ${model} through the Anthropic API. Override the model with LINGOLOOP_MODEL.`
      : `The Anthropic provider was requested explicitly but ANTHROPIC_API_KEY is not set, so every batch will fail with a provider error. Set the key, or unset LINGOLOOP_PROVIDER to fall back to offline simulation.`,
  };
}
