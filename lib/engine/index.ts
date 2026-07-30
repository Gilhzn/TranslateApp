/**
 * LingoLoop translation engine — prompts, providers, and response parsing.
 *
 * The shape a caller normally uses:
 *
 *   1. `resolveProvider()`            pick the live API or the offline simulator
 *   2. `describeActiveProvider()`     tell the developer, honestly, which one
 *   3. `chunkUnits(units)`            split work into sibling-preserving batches
 *   4. `provider.translate(request)`  run one batch (never throws)
 *   5. `parseProviderOutput(raw)`     only needed for a custom provider
 *
 * Everything except `AnthropicProvider.translate` is pure and runs unchanged in
 * Node and in the browser: the Anthropic SDK is imported lazily inside
 * `translate()` so importing this barrel from a client component does not pull
 * it into the bundle.
 */

export {
  TONE_SPECS,
  buildSystemPrompt,
  buildUserPrompt,
  lookupGlossaryTarget,
  placeholderRule,
  resolveGlossary,
  roleGuidance,
  toneSpec,
} from "./prompt";
export type { GlossaryLine, ToneSpec } from "./prompt";

export {
  parseProviderOutput,
  stripTrailingCommas,
  stripWrapper,
  extractJson,
} from "./parse";
export type { ParseOptions, ParsedProviderOutput } from "./parse";

export {
  batchRequests,
  chunkUnits,
  estimateUnitTokens,
  siblingGroupOf,
} from "./batch";
export type { BatchOptions } from "./batch";

export {
  ANTHROPIC_PROVIDER_ID,
  AnthropicProvider,
  DEFAULT_MODEL,
  DEFAULT_TEMPERATURE,
  classifyError,
  maxTokensFor,
} from "./anthropic";
export type {
  AnthropicMessageLike,
  AnthropicMessagesClient,
  AnthropicProviderOptions,
  ClassifiedError,
} from "./anthropic";

export {
  DETERMINISTIC_PROVIDER_ID,
  DeterministicProvider,
  applyGlossary,
  hash32,
  scriptForLocale,
  simulateTranslation,
  splitOnPlaceholders,
} from "./simulation";
export type {
  DeterministicProviderOptions,
  SimulationContext,
} from "./simulation";

export {
  describeActiveProvider,
  parseMode,
  readEngineEnv,
  resolveProvider,
} from "./provider";
export type {
  ActiveProviderDescription,
  EngineEnv,
  ProviderMode,
  ResolveProviderOptions,
} from "./provider";
