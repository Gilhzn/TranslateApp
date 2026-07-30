/**
 * SERVER-SIDE ONLY. The live provider.
 *
 * Three things make this module more than a `fetch` wrapper:
 *
 *   1. It never throws. A batch that fails after every retry comes back as a
 *      `provider-error` Issue attached to a `ProviderResponse`, because the
 *      caller is a loop over dozens of batches and one dead batch must not take
 *      the job down with it.
 *   2. Retries distinguish *retryable* from *terminal*. Retrying a 401 is a way
 *      to turn one authentication failure into four; retrying a 429 without
 *      honouring `Retry-After` is a way to get rate limited harder.
 *   3. The SDK is imported dynamically. `lib/engine/index.ts` is imported by
 *      client components (for `describeActiveProvider`), and a static
 *      `import "@anthropic-ai/sdk"` anywhere in that graph pulls the whole SDK
 *      into the browser bundle. The import below happens inside `translate()`,
 *      which only ever runs on the server.
 */

import type {
  Issue,
  ProviderRequest,
  ProviderResponse,
  TranslationProvider,
} from "@/lib/types";
import { parseProviderOutput } from "./parse";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";

export const ANTHROPIC_PROVIDER_ID = "anthropic";

/** Overridable with `LINGOLOOP_MODEL`. */
export const DEFAULT_MODEL = "claude-sonnet-5";

/**
 * Models that reject `temperature` / `top_p` / `top_k` outright (HTTP 400).
 * Determinism on those models comes from the prompt, not from sampling knobs,
 * so the parameter is dropped rather than sent and refused.
 */
const NO_SAMPLING_PARAMS = [
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-fable-5",
  "claude-mythos-5",
];

/** Low but non-zero: some lexical variety helps when a repair pass needs a different word. */
export const DEFAULT_TEMPERATURE = 0.2;

/** Output ceiling. Kept under the SDK's non-streaming HTTP timeout envelope. */
const DEFAULT_MAX_TOKENS = 8000;
/** Roughly the output cost of one translated unit, plus JSON scaffolding. */
const TOKENS_PER_UNIT = 120;

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8000;
/** Never sleep longer than this for a server-supplied `Retry-After`. */
const MAX_HONOURED_RETRY_AFTER_MS = 30_000;

// ---------------------------------------------------------------------------
// Minimal structural view of the SDK
// ---------------------------------------------------------------------------

/**
 * Only what this module uses. Declaring it structurally (rather than importing
 * SDK types) keeps the module free of a compile-time dependency on the SDK's
 * exact generics and makes the client trivially fakeable in tests.
 */
export interface AnthropicMessagesClient {
  create(
    request: {
      model: string;
      maxTokens: number;
      system: string;
      user: string;
      temperature?: number;
    },
    signal?: AbortSignal,
  ): Promise<AnthropicMessageLike>;
}

export interface AnthropicMessageLike {
  content: ReadonlyArray<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string | null;
}

export interface AnthropicProviderOptions {
  apiKey?: string;
  model?: string;
  /** Total attempts including the first. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Explicit temperature; ignored for models that reject sampling parameters. */
  temperature?: number;
  /** Injectable for tests. Defaults to the real SDK, loaded lazily. */
  createClient?: (apiKey: string) => Promise<AnthropicMessagesClient>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Deterministic jitter source for tests. Returns [0, 1). */
  random?: () => number;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements TranslationProvider {
  readonly id = ANTHROPIC_PROVIDER_ID;
  readonly label = "Anthropic API";

  readonly model: string;

  private readonly apiKey: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly temperature: number | undefined;
  private readonly createClient: (apiKey: string) => Promise<AnthropicMessagesClient>;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  private client: AnthropicMessagesClient | null = null;

  constructor(options: AnthropicProviderOptions = {}) {
    this.apiKey = options.apiKey ?? readEnv("ANTHROPIC_API_KEY") ?? "";
    this.model = options.model ?? readEnv("LINGOLOOP_MODEL") ?? DEFAULT_MODEL;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
    this.maxDelayMs = Math.max(this.baseDelayMs, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
    this.temperature = resolveTemperature(this.model, options.temperature);
    this.createClient = options.createClient ?? createSdkClient;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async translate(
    request: ProviderRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResponse> {
    if (request.units.length === 0) return { translations: [], issues: [] };

    // The dynamic import below keeps the SDK out of the client bundle; this is
    // the belt to that braces. Reaching here in a browser means an API route
    // leaked into a client component and the key would be exposed.
    if (typeof window !== "undefined") {
      return failure(
        "AnthropicProvider is server-only: it reads ANTHROPIC_API_KEY and must never run in the browser. Call it from a route handler or server action.",
      );
    }
    if (!this.isConfigured()) {
      return failure(
        "ANTHROPIC_API_KEY is not set, so the Anthropic provider cannot run. Configure a key or use the offline simulation provider.",
      );
    }
    if (isAborted(signal)) return failure(CANCELLED, "warning");

    const system = buildSystemPrompt(request);
    const user = buildUserPrompt(request);
    const maxTokens = maxTokensFor(request);

    let lastError = "";
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (isAborted(signal)) return failure(CANCELLED, "warning");

      let message: AnthropicMessageLike;
      try {
        const client = await this.ensureClient();
        const params: Parameters<AnthropicMessagesClient["create"]>[0] = {
          model: this.model,
          maxTokens,
          system,
          user,
        };
        if (this.temperature !== undefined) params.temperature = this.temperature;
        message = await client.create(params, signal);
      } catch (error) {
        if (isAborted(signal)) return failure(CANCELLED, "warning");

        const classified = classifyError(error);
        lastError = classified.message;
        if (!classified.retryable || attempt === this.maxAttempts) {
          return failure(
            `Anthropic request failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${classified.message}`,
            "error",
            { attempts: attempt, retryable: classified.retryable, model: this.model },
          );
        }
        const delay = this.delayFor(attempt, classified.retryAfterMs);
        await this.sleep(delay, signal);
        continue;
      }

      const text = extractText(message);
      if (text.trim().length === 0) {
        lastError = `the model returned no text (stop_reason: ${message.stop_reason ?? "unknown"})`;
        if (attempt === this.maxAttempts) break;
        await this.sleep(this.delayFor(attempt), signal);
        continue;
      }

      const parsed = parseProviderOutput(text, {
        expectedKeys: request.units.map((unit) => unit.key),
        source: "Anthropic API",
      });

      const response: ProviderResponse = {
        translations: parsed.translations,
        issues: parsed.issues,
      };
      const usage = readUsage(message);
      if (usage !== undefined) response.usage = usage;
      if (message.stop_reason === "max_tokens") {
        response.issues.push({
          code: "provider-error",
          severity: "warning",
          message:
            "The model hit its output limit; some translations in this batch may be missing. Reduce the batch size.",
          detail: { maxTokens },
        });
      }
      return response;
    }

    return failure(
      `Anthropic request produced no usable output after ${this.maxAttempts} attempts: ${lastError}`,
      "error",
      { attempts: this.maxAttempts, model: this.model },
    );
  }

  private async ensureClient(): Promise<AnthropicMessagesClient> {
    if (this.client === null) {
      this.client = await this.createClient(this.apiKey);
    }
    return this.client;
  }

  /**
   * Exponential backoff with full jitter, capped. `Retry-After` wins when the
   * server supplied one — it knows when the window reopens and we do not.
   */
  private delayFor(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      return Math.min(retryAfterMs, MAX_HONOURED_RETRY_AFTER_MS);
    }
    const ceiling = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
    // Full jitter: uniform over [0, ceiling]. Retrying a whole batch of
    // requests on the same schedule is how a 429 becomes a thundering herd.
    return Math.round(ceiling * this.random());
  }
}

const CANCELLED = "Translation was cancelled before the request completed.";

/**
 * Wrapped in a function on purpose: an inline `signal?.aborted === true` is
 * narrowed to `false` by the compiler after the first check, which would make
 * every later check dead code.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function failure(
  message: string,
  severity: Issue["severity"] = "error",
  detail?: Record<string, string | number | boolean | null>,
): ProviderResponse {
  const issue: Issue = { code: "provider-error", severity, message };
  if (detail !== undefined) issue.detail = detail;
  return { translations: [], issues: [issue] };
}

/** Output budget for a batch: enough for every unit plus JSON scaffolding. */
export function maxTokensFor(request: ProviderRequest): number {
  const sourceChars = request.units.reduce(
    (sum, unit) => sum + unit.source.length,
    0,
  );
  const estimate =
    request.units.length * TOKENS_PER_UNIT + Math.ceil(sourceChars / 2) + 512;
  return Math.min(DEFAULT_MAX_TOKENS, Math.max(1024, estimate));
}

function resolveTemperature(
  model: string,
  explicit: number | undefined,
): number | undefined {
  if (NO_SAMPLING_PARAMS.some((id) => model.startsWith(id))) return undefined;
  return explicit ?? DEFAULT_TEMPERATURE;
}

function extractText(message: AnthropicMessageLike): string {
  let out = "";
  for (const block of message.content) {
    if (block.type === "text" && typeof block.text === "string") out += block.text;
  }
  return out;
}

function readUsage(
  message: AnthropicMessageLike,
): { inputTokens: number; outputTokens: number } | undefined {
  const usage = message.usage;
  if (usage === undefined) return undefined;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  };
}

export interface ClassifiedError {
  message: string;
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
}

/**
 * 429, 408, 409 and 5xx are transient by definition; a request that never got a
 * status at all is a network failure and also worth retrying. Everything else
 * (400 malformed, 401 bad key, 403, 404 unknown model, 413 too large) will fail
 * identically on the next attempt.
 */
export function classifyError(error: unknown): ClassifiedError {
  const status = readStatus(error);
  const message = readMessage(error);
  const retryAfterMs = readRetryAfter(error);

  if (status === undefined) {
    // No HTTP status: a transport failure, unless the SDK told us it aborted.
    const aborted = /abort/i.test(message);
    const result: ClassifiedError = { message, retryable: !aborted };
    if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs;
    return result;
  }

  const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
  const result: ClassifiedError = {
    message: `HTTP ${status} — ${message}`,
    retryable,
    status,
  };
  if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs;
  return result;
}

function readStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const status = record.status ?? record.statusCode;
  return typeof status === "number" ? status : undefined;
}

function readMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return "unknown error";
}

/** `Retry-After` in seconds or as an HTTP date, from whatever shape carries it. */
function readRetryAfter(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;

  const headers = record.headers;
  const raw = readHeader(headers, "retry-after") ?? readHeader(headers, "Retry-After");
  if (raw === undefined) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (headers === undefined || headers === null) return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get: (key: string) => unknown }).get(name);
    return typeof value === "string" ? value : undefined;
  }
  if (typeof headers === "object") {
    const value = (headers as Record<string, unknown>)[name];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function readEnv(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  const value = process.env?.[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** Lazily loads the real SDK and adapts it to the structural interface above. */
async function createSdkClient(apiKey: string): Promise<AnthropicMessagesClient> {
  if (typeof window !== "undefined") {
    throw new Error("The Anthropic SDK must never be loaded in the browser.");
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  // Retries are this module's job: the SDK's own retry loop would silently
  // multiply the attempt cap and ignore our AbortSignal accounting.
  const sdk = new Anthropic({ apiKey, maxRetries: 0 });

  return {
    async create(request, signal) {
      const message = await sdk.messages.create(
        {
          model: request.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: [{ role: "user", content: request.user }],
          ...(request.temperature === undefined
            ? {}
            : { temperature: request.temperature }),
        },
        signal === undefined ? undefined : { signal },
      );
      return {
        content: message.content,
        usage: message.usage,
        stop_reason: message.stop_reason,
      };
    },
  };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (isAborted(signal) || ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
