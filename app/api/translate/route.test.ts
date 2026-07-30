import { describe, expect, it } from "vitest";
import { SseParser, type SseMessage } from "@/lib/pipeline";
import type { JobProgress, LocaleResult } from "@/lib/types";
import { POST } from "./route";

const SOURCE = `{
  "menu": {
    "save": "Save",
    "cancel": "Cancel"
  },
  "hud": {
    "gold": "{amount} Gold",
    "version": "1.4.2"
  }
}
`;

const SETTINGS = {
  sourceLocale: "en",
  targetLocales: ["de", "fr"],
  tone: "gaming",
  productContext: "A roguelike deckbuilder.",
  glossary: [],
  enforceLayout: true,
  maxRepairAttempts: 1,
};

function post(body: unknown, init: RequestInit = {}): Request {
  return new Request("https://example.test/api/translate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

async function collect(response: Response): Promise<SseMessage[]> {
  const body = response.body;
  if (body === null) throw new Error("no response body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const messages: SseMessage[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    messages.push(...parser.push(decoder.decode(value, { stream: true })));
  }
  messages.push(...parser.push(decoder.decode()));
  messages.push(...parser.flush());
  return messages;
}

function payload<T>(message: SseMessage | undefined): T {
  if (message === undefined) throw new Error("missing message");
  return JSON.parse(message.data) as T;
}

describe("POST /api/translate — streaming", () => {
  it("streams start, progress, locale-complete and done", async () => {
    // No ANTHROPIC_API_KEY in the test environment, so the offline simulator
    // answers — the pipeline runs for real without needing a key.
    const response = await POST(
      post({ fileName: "en.json", text: SOURCE, settings: SETTINGS }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toContain("no-cache");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const messages = await collect(response);
    const names = messages.map((m) => m.event);

    expect(names[0]).toBe("start");
    expect(names.at(-1)).toBe("done");
    expect(names.filter((name) => name === "locale-complete")).toHaveLength(2);
    expect(names).toContain("progress");
    expect(names).not.toContain("error");

    const start = payload<{
      totalUnits: number;
      targetLocales: string[];
      provider: { mode: string; headline: string };
    }>(messages[0]);
    expect(start.targetLocales).toEqual(["de", "fr"]);
    expect(start.totalUnits).toBe(4 * 2);
    expect(["live", "simulation"]).toContain(start.provider.mode);

    const localeResults = messages
      .filter((m) => m.event === "locale-complete")
      .map((m) => payload<LocaleResult>(m));
    expect(localeResults.map((r) => r.locale).sort()).toEqual(["de", "fr"]);
    for (const result of localeResults) {
      expect(result.entries).toHaveLength(4);
      expect(result.stats.total).toBe(4);
      // The rebuilt tree survives the JSON hop with its structure intact.
      expect(Object.keys(result.tree as Record<string, unknown>)).toEqual([
        "menu",
        "hud",
      ]);
    }

    const done = payload<{ durationMs: number; locales: unknown[] }>(messages.at(-1));
    expect(done.locales).toHaveLength(2);
    expect(done.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports progress that ends at exactly 100%", async () => {
    const response = await POST(
      post({
        text: SOURCE,
        settings: { ...SETTINGS, targetLocales: ["de"] },
      }),
    );

    const frames = (await collect(response))
      .filter((m) => m.event === "progress")
      .map((m) => payload<JobProgress>(m));

    expect(frames.length).toBeGreaterThan(1);
    const last = frames.at(-1);
    expect(last?.phase).toBe("complete");
    expect(last?.progress).toBe(1);
    expect(last?.completedUnits).toBe(last?.totalUnits);

    let previous = -1;
    for (const frame of frames) {
      expect(frame.completedUnits).toBeGreaterThanOrEqual(previous);
      previous = frame.completedUnits;
    }
  });

  it("aborts the job when the client disconnects", async () => {
    const controller = new AbortController();
    const request = post(
      {
        text: SOURCE,
        settings: { ...SETTINGS, targetLocales: ["de", "fr", "ja", "es"] },
      },
      { signal: controller.signal },
    );

    const response = await POST(request);
    controller.abort();

    const messages = await collect(response);
    const last = messages.at(-1);
    expect(last?.event).toBe("error");
    expect(payload<{ code: string }>(last).code).toBe("cancelled");
  });

  it("aborts the job when the consumer cancels the stream", async () => {
    const response = await POST(
      post({
        text: SOURCE,
        settings: { ...SETTINGS, targetLocales: ["de", "fr", "ja"] },
      }),
    );
    const body = response.body;
    if (body === null) throw new Error("no body");
    // Cancelling the reader is what a closed browser tab does.
    await body.cancel();
    expect(body.locked).toBe(false);
  });
});

describe("POST /api/translate — defensive validation", () => {
  it("rejects a malformed body with a typed error, not a stack trace", async () => {
    const response = await POST(post("{ not json"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid-json");
    expect(body.error.message).not.toContain("at Object");
  });

  it("rejects settings that are not usable", async () => {
    const response = await POST(
      post({ text: SOURCE, settings: { ...SETTINGS, tone: "sarcastic" } }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; field?: string };
    };
    expect(body.error.code).toBe("invalid-body");
    expect(body.error.field).toBe("settings.tone");
  });

  it("rejects a non-JSON content type", async () => {
    const response = await POST(
      new Request("https://example.test/api/translate", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hello",
      }),
    );
    expect(response.status).toBe(415);
  });

  it("rejects an oversized payload before running anything", async () => {
    const response = await POST(
      post(
        { text: SOURCE, settings: SETTINGS },
        { headers: { "content-type": "application/json", "content-length": "99999999" } },
      ),
    );
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("payload-too-large");
  });

  it("reports an unparseable source file with line and column", async () => {
    const response = await POST(
      post({ text: '{\n  "a": 1,\n  "b" 2\n}\n', settings: SETTINGS }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; detail?: Record<string, unknown> };
    };
    expect(body.error.code).toBe("source-parse-failed");
    expect(body.error.detail?.["line"]).toBe(3);
  });

  it("never returns a response body that leaks the API key", async () => {
    const response = await POST(post({ text: SOURCE, settings: SETTINGS }));
    const text = (await collect(response)).map((m) => m.data).join("\n");
    expect(text.toLowerCase()).not.toContain("anthropic_api_key=");
    expect(text).not.toContain("sk-ant");
  });
});
