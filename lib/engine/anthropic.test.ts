import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AnthropicProvider,
  DEFAULT_MODEL,
  classifyError,
  maxTokensFor,
  type AnthropicMessageLike,
  type AnthropicMessagesClient,
  type AnthropicProviderOptions,
} from "./anthropic";
import { makeRequest, makeUnit } from "./testing";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface Call {
  model: string;
  maxTokens: number;
  system: string;
  user: string;
  temperature?: number;
}

type Step = AnthropicMessageLike | Error;

function textMessage(
  text: string,
  extra: Partial<AnthropicMessageLike> = {},
): AnthropicMessageLike {
  return { content: [{ type: "text", text }], ...extra };
}

function httpError(status: number, message = "boom", headers?: Record<string, string>): Error {
  const error = new Error(message) as Error & {
    status: number;
    headers?: Record<string, string>;
  };
  error.status = status;
  if (headers !== undefined) error.headers = headers;
  return error;
}

interface Harness {
  provider: AnthropicProvider;
  calls: Call[];
  delays: number[];
}

function harness(steps: Step[], options: AnthropicProviderOptions = {}): Harness {
  const calls: Call[] = [];
  const delays: number[] = [];
  let index = 0;

  const client: AnthropicMessagesClient = {
    async create(request) {
      calls.push({ ...request });
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      if (step === undefined) throw new Error("no step configured");
      if (step instanceof Error) throw step;
      return step;
    },
  };

  const provider = new AnthropicProvider({
    apiKey: "sk-test",
    model: "claude-sonnet-5",
    createClient: async () => client,
    sleep: async (ms) => {
      delays.push(ms);
    },
    random: () => 0.5,
    ...options,
  });

  return { provider, calls, delays };
}

const REQUEST = makeRequest({
  units: [
    makeUnit({ key: "menu.save", source: "Save" }),
    makeUnit({ key: "menu.open", source: "Open" }),
  ],
});

const GOOD_JSON =
  '{"translations":[{"key":"menu.save","target":"Speichern"},{"key":"menu.open","target":"Öffnen"}]}';

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe("AnthropicProvider", () => {
  describe("configuration", () => {
    it("reports whether a key is present", () => {
      expect(new AnthropicProvider({ apiKey: "sk-x" }).isConfigured()).toBe(true);
      expect(new AnthropicProvider({ apiKey: "" }).isConfigured()).toBe(false);
    });

    it("defaults the model and honours LINGOLOOP_MODEL", () => {
      vi.stubEnv("LINGOLOOP_MODEL", "");
      expect(new AnthropicProvider({ apiKey: "sk-x" }).model).toBe(DEFAULT_MODEL);

      vi.stubEnv("LINGOLOOP_MODEL", "claude-opus-4-5");
      expect(new AnthropicProvider({ apiKey: "sk-x" }).model).toBe("claude-opus-4-5");

      expect(
        new AnthropicProvider({ apiKey: "sk-x", model: "explicit-model" }).model,
      ).toBe("explicit-model");
    });

    it("reads ANTHROPIC_API_KEY from the environment", () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-from-env");
      expect(new AnthropicProvider().isConfigured()).toBe(true);
    });

    it("returns a provider error instead of throwing when unconfigured", async () => {
      const provider = new AnthropicProvider({ apiKey: "" });
      const response = await provider.translate(REQUEST);
      expect(response.translations).toEqual([]);
      expect(response.issues[0]?.code).toBe("provider-error");
      expect(response.issues[0]?.message).toMatch(/ANTHROPIC_API_KEY is not set/);
    });

    it("refuses to run in a browser rather than leaking the key", async () => {
      vi.stubGlobal("window", {});
      try {
        const { provider } = harness([textMessage(GOOD_JSON)]);
        const response = await provider.translate(REQUEST);
        expect(response.issues[0]?.message).toMatch(/server-only/);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe("request shape", () => {
    it("sends the system and user prompts and a positive token budget", async () => {
      const { provider, calls } = harness([textMessage(GOOD_JSON)]);
      await provider.translate(REQUEST);

      const call = calls[0]!;
      expect(call.model).toBe("claude-sonnet-5");
      expect(call.system).toMatch(/senior localisation engineer/);
      expect(call.user).toContain('key: "menu.save"');
      expect(call.maxTokens).toBeGreaterThan(0);
    });

    it("omits temperature on models that reject sampling parameters", async () => {
      const { provider, calls } = harness([textMessage(GOOD_JSON)]);
      await provider.translate(REQUEST);
      expect(calls[0]).not.toHaveProperty("temperature");
    });

    it("sends a low temperature on models that accept it", async () => {
      const { provider, calls } = harness([textMessage(GOOD_JSON)], {
        model: "claude-haiku-4-5",
      });
      await provider.translate(REQUEST);
      expect(calls[0]?.temperature).toBe(0.2);
    });

    it("does not call the API at all for an empty batch", async () => {
      const { provider, calls } = harness([textMessage(GOOD_JSON)]);
      const response = await provider.translate(makeRequest({ units: [] }));
      expect(calls).toHaveLength(0);
      expect(response.translations).toEqual([]);
    });
  });

  describe("responses", () => {
    it("parses translations and reports usage", async () => {
      const { provider } = harness([
        textMessage(GOOD_JSON, { usage: { input_tokens: 1200, output_tokens: 42 } }),
      ]);
      const response = await provider.translate(REQUEST);

      expect(response.translations).toEqual([
        { key: "menu.save", target: "Speichern" },
        { key: "menu.open", target: "Öffnen" },
      ]);
      expect(response.usage).toEqual({ inputTokens: 1200, outputTokens: 42 });
      expect(response.issues).toEqual([]);
    });

    it("tolerates fenced output", async () => {
      const { provider } = harness([textMessage("```json\n" + GOOD_JSON + "\n```")]);
      expect((await provider.translate(REQUEST)).translations).toHaveLength(2);
    });

    it("reports keys the model failed to return", async () => {
      const { provider } = harness([
        textMessage('{"translations":[{"key":"menu.save","target":"Speichern"}]}'),
      ]);
      const response = await provider.translate(REQUEST);
      expect(response.translations).toHaveLength(1);
      expect(response.issues.map((issue) => issue.key)).toContain("menu.open");
    });

    it("warns when the model ran out of output tokens", async () => {
      const { provider } = harness([textMessage(GOOD_JSON, { stop_reason: "max_tokens" })]);
      const response = await provider.translate(REQUEST);
      expect(
        response.issues.some((issue) => /hit its output limit/.test(issue.message)),
      ).toBe(true);
    });

    it("ignores non-text content blocks", async () => {
      const { provider } = harness([
        { content: [{ type: "thinking" }, { type: "text", text: GOOD_JSON }] },
      ]);
      expect((await provider.translate(REQUEST)).translations).toHaveLength(2);
    });

    it("retries an empty response and gives up cleanly", async () => {
      const { provider, calls } = harness([{ content: [] }], { maxAttempts: 3 });
      const response = await provider.translate(REQUEST);
      expect(calls).toHaveLength(3);
      expect(response.issues[0]?.message).toMatch(/no usable output/);
    });
  });

  describe("retries", () => {
    it("retries a 429 and succeeds", async () => {
      const { provider, calls } = harness([
        httpError(429, "rate limited"),
        textMessage(GOOD_JSON),
      ]);
      const response = await provider.translate(REQUEST);
      expect(calls).toHaveLength(2);
      expect(response.translations).toHaveLength(2);
      expect(response.issues).toEqual([]);
    });

    it("retries 5xx and network failures", async () => {
      for (const error of [httpError(500), httpError(529), new Error("socket hang up")]) {
        const { provider, calls } = harness([error, textMessage(GOOD_JSON)]);
        const response = await provider.translate(REQUEST);
        expect(calls).toHaveLength(2);
        expect(response.translations).toHaveLength(2);
      }
    });

    it("does not retry a terminal 4xx", async () => {
      for (const status of [400, 401, 403, 404, 413]) {
        const { provider, calls } = harness([httpError(status, "nope")]);
        const response = await provider.translate(REQUEST);
        expect(calls).toHaveLength(1);
        expect(response.issues[0]?.detail?.retryable).toBe(false);
        expect(response.issues[0]?.message).toContain(`HTTP ${status}`);
      }
    });

    it("caps total attempts and surfaces an issue instead of throwing", async () => {
      const { provider, calls } = harness([httpError(500)], { maxAttempts: 3 });
      const response = await provider.translate(REQUEST);
      expect(calls).toHaveLength(3);
      expect(response.issues[0]?.code).toBe("provider-error");
      expect(response.issues[0]?.detail?.attempts).toBe(3);
    });

    it("backs off exponentially with jitter, under the cap", async () => {
      const { provider, delays } = harness([httpError(500)], {
        maxAttempts: 5,
        baseDelayMs: 100,
        maxDelayMs: 500,
        random: () => 1,
      });
      await provider.translate(REQUEST);
      expect(delays).toEqual([100, 200, 400, 500]);
    });

    it("applies jitter rather than retrying on a fixed schedule", async () => {
      const { provider, delays } = harness([httpError(500)], {
        maxAttempts: 3,
        baseDelayMs: 1000,
        random: () => 0.25,
      });
      await provider.translate(REQUEST);
      expect(delays).toEqual([250, 500]);
    });

    it("honours a numeric Retry-After", async () => {
      const { provider, delays } = harness([
        httpError(429, "slow down", { "retry-after": "3" }),
        textMessage(GOOD_JSON),
      ]);
      await provider.translate(REQUEST);
      expect(delays).toEqual([3000]);
    });

    it("honours a Retry-After date and clamps an absurd one", async () => {
      const far = new Date(Date.now() + 60 * 60 * 1000).toUTCString();
      const { provider, delays } = harness([
        httpError(429, "slow down", { "retry-after": far }),
        textMessage(GOOD_JSON),
      ]);
      await provider.translate(REQUEST);
      expect(delays[0]).toBe(30_000);
    });

    it("reads Retry-After from a Headers-like object", async () => {
      const error = httpError(429);
      (error as unknown as { headers: unknown }).headers = new Headers({
        "retry-after": "2",
      });
      const { provider, delays } = harness([error, textMessage(GOOD_JSON)]);
      await provider.translate(REQUEST);
      expect(delays).toEqual([2000]);
    });
  });

  describe("cancellation", () => {
    it("returns immediately when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const { provider, calls } = harness([textMessage(GOOD_JSON)]);

      const response = await provider.translate(REQUEST, controller.signal);
      expect(calls).toHaveLength(0);
      expect(response.issues[0]?.message).toMatch(/cancelled/i);
      expect(response.issues[0]?.severity).toBe("warning");
    });

    it("stops retrying once the signal aborts mid-flight", async () => {
      const controller = new AbortController();
      const calls: Call[] = [];
      const provider = new AnthropicProvider({
        apiKey: "sk-test",
        model: "claude-sonnet-5",
        maxAttempts: 5,
        sleep: async () => {},
        createClient: async () => ({
          async create(request) {
            calls.push({ ...request });
            controller.abort();
            throw httpError(500);
          },
        }),
      });

      const response = await provider.translate(REQUEST, controller.signal);
      expect(calls).toHaveLength(1);
      expect(response.issues[0]?.message).toMatch(/cancelled/i);
    });

    it("passes the signal through to the client", async () => {
      const controller = new AbortController();
      let seen: AbortSignal | undefined;
      const provider = new AnthropicProvider({
        apiKey: "sk-test",
        createClient: async () => ({
          async create(_request, signal) {
            seen = signal;
            return textMessage(GOOD_JSON);
          },
        }),
      });

      await provider.translate(REQUEST, controller.signal);
      expect(seen).toBe(controller.signal);
    });
  });
});

describe("classifyError", () => {
  it("treats 408, 409, 429 and 5xx as retryable", () => {
    for (const status of [408, 409, 429, 500, 502, 529]) {
      expect(classifyError(httpError(status)).retryable).toBe(true);
    }
  });

  it("treats client errors as terminal", () => {
    for (const status of [400, 401, 403, 404, 413, 422]) {
      expect(classifyError(httpError(status)).retryable).toBe(false);
    }
  });

  it("treats a status-less failure as a retryable transport error", () => {
    expect(classifyError(new Error("ECONNRESET")).retryable).toBe(true);
  });

  it("does not retry an abort", () => {
    expect(classifyError(new Error("Request was aborted.")).retryable).toBe(false);
  });

  it("survives a non-Error throw", () => {
    expect(classifyError("something odd").message).toBe("something odd");
    expect(classifyError(undefined).message).toBe("unknown error");
  });
});

describe("maxTokensFor", () => {
  it("scales with the batch and stays within sane bounds", () => {
    const small = maxTokensFor(makeRequest({ units: [makeUnit({ key: "a", source: "Save" })] }));
    const large = maxTokensFor(
      makeRequest({
        units: Array.from({ length: 40 }, (_, i) =>
          makeUnit({ key: `k${i}`, source: "A moderately long source string" }),
        ),
      }),
    );
    expect(small).toBeGreaterThanOrEqual(1024);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThanOrEqual(8000);
  });
});
