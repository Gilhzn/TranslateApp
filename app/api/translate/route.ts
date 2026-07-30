/**
 * POST /api/translate — run a job and stream its progress as Server-Sent
 * Events.
 *
 * Server-only by construction: the Anthropic key is read here, inside a route
 * handler, and never travels to the client. The browser learns which provider
 * answered from the `start` event and from `/api/health`, never from a key.
 *
 * Event sequence:
 *
 *   start           once, with the job id, provider mode and unit totals
 *   progress        JobProgress — every phase transition, and unit completions
 *   locale-complete LocaleResult — once per target locale, as it finishes
 *   done | error    exactly one, then the stream closes
 *
 * A client that disconnects aborts the job: `request.signal` and the stream's
 * `cancel` both feed the same controller, so an abandoned tab stops costing
 * model calls within one batch rather than running to completion.
 */

import { describeActiveProvider, resolveProvider } from "@/lib/engine";
import {
  MAX_REQUEST_BYTES,
  PipelineRequestError,
  encodeSseComment,
  encodeSseEvent,
  isJobAborted,
  parseTranslateRequest,
  readJsonBody,
  runJob,
  StructuralIntegrityError,
} from "@/lib/pipeline";
import type { TranslateRequest } from "@/lib/pipeline";
import type { JobPhase, JobProgress, LocaleResult } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Minimum gap between two *unit-completion* progress frames, in milliseconds.
 *
 * Phase transitions and the final frame of every burst are always sent, so no
 * information is lost — this only stops a 4,000-string job from emitting 4,000
 * frames faster than a browser can paint them. Counts stay exact because each
 * frame carries absolute totals rather than a delta.
 */
const PROGRESS_MIN_INTERVAL_MS = 40;

/** Comment frame cadence, to keep intermediary proxies from idling us out. */
const HEARTBEAT_MS = 15_000;

const SSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-store, no-transform",
  Connection: "keep-alive",
  // Nginx and several PaaS proxies buffer unknown streams by default, which
  // turns a live progress feed into one delivery at the end.
  "X-Accel-Buffering": "no",
};

export async function POST(request: Request): Promise<Response> {
  let parsed: TranslateRequest;
  try {
    const body = await readJsonBody(request, MAX_REQUEST_BYTES);
    parsed = parseTranslateRequest(body);
  } catch (error) {
    return requestErrorResponse(error);
  }

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (request.signal.aborted) controller.abort();
  else request.signal.addEventListener("abort", abort, { once: true });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(sink) {
      // Not awaited: the Response must be returned before the job runs, or the
      // browser sees nothing until the last locale is done.
      void pump(sink);
    },
    cancel() {
      controller.abort();
    },
  });

  async function pump(sink: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    let closed = false;

    const write = (chunk: string): void => {
      if (closed || chunk.length === 0) return;
      try {
        sink.enqueue(encoder.encode(chunk));
      } catch {
        // The consumer went away between our abort check and this enqueue.
        closed = true;
        controller.abort();
      }
    };

    let lastFrameAt = Date.now();
    let pendingProgress: JobProgress | null = null;
    let lastPhase: JobPhase | null = null;

    const sendProgress = (progress: JobProgress): void => {
      // A phase transition is the frame a human actually reads, so it is never
      // coalesced; unit completions are throttled because a 4,000-string job
      // emits them faster than a browser can paint. Counts stay exact either
      // way: every frame carries absolute totals, never a delta.
      const force = progress.phase !== lastPhase || progress.progress >= 1;
      lastPhase = progress.phase;
      const now = Date.now();
      if (!force && now - lastFrameAt < PROGRESS_MIN_INTERVAL_MS) {
        pendingProgress = progress;
        return;
      }
      pendingProgress = null;
      lastFrameAt = now;
      write(encodeSseEvent("progress", progress));
    };

    const flushProgress = (): void => {
      if (pendingProgress === null) return;
      const progress = pendingProgress;
      pendingProgress = null;
      lastFrameAt = Date.now();
      write(encodeSseEvent("progress", progress));
    };

    const heartbeat: ReturnType<typeof setInterval> = setInterval(() => {
      if (closed) return;
      if (Date.now() - lastFrameAt < HEARTBEAT_MS) return;
      lastFrameAt = Date.now();
      write(encodeSseComment("keep-alive"));
    }, HEARTBEAT_MS);
    // Node keeps the process alive for pending timers; a stream that outlives
    // its request must not be the reason an invocation hangs. `unref` does not
    // exist on the DOM timer type, hence the guard rather than a bare call.
    const timer: unknown = heartbeat;
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }

    const provider = resolveProvider();
    const description = describeActiveProvider();

    write(
      encodeSseEvent("start", {
        fileName: parsed.catalog.fileName,
        sourceLocale: parsed.catalog.sourceLocale,
        targetLocales: parsed.settings.targetLocales,
        totalUnits:
          parsed.catalog.entries.length * parsed.settings.targetLocales.length,
        translatableKeys: parsed.catalog.stats.translatableKeys,
        provider: description,
      }),
    );

    try {
      const job = await runJob({
        catalog: parsed.catalog,
        settings: parsed.settings,
        provider,
        signal: controller.signal,
        onProgress: sendProgress,
        onLocaleComplete: (result: LocaleResult) => {
          flushProgress();
          lastFrameAt = Date.now();
          write(encodeSseEvent("locale-complete", result));
        },
      });

      flushProgress();
      write(
        encodeSseEvent("done", {
          jobId: job.id,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
          durationMs: (job.finishedAt ?? Date.now()) - job.startedAt,
          locales: job.results.map((result) => ({
            locale: result.locale,
            stats: result.stats,
          })),
          issues: job.issues,
          progress: job.progress,
        }),
      );
    } catch (error) {
      flushProgress();
      write(encodeSseEvent("error", jobErrorPayload(error)));
    } finally {
      clearInterval(heartbeat);
      request.signal.removeEventListener("abort", abort);
      if (!closed) {
        closed = true;
        try {
          sink.close();
        } catch {
          // Already closed by a cancelled consumer; nothing to do.
        }
      }
    }
  }

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

interface JobErrorPayload {
  code: string;
  message: string;
  detail?: Record<string, string | number | boolean | null>;
  paths?: string[];
}

function jobErrorPayload(error: unknown): JobErrorPayload {
  if (isJobAborted(error)) {
    return { code: "cancelled", message: error.message };
  }
  if (error instanceof StructuralIntegrityError) {
    return {
      code: "structure-mismatch",
      message: error.message,
      detail: { locale: error.locale, divergences: error.issues.length },
      // The first handful of diverging paths is what makes this debuggable;
      // the full list can run to hundreds and belongs in the server log.
      paths: error.issues
        .slice(0, 10)
        .map((candidate) => String(candidate.detail?.["path"] ?? candidate.key ?? "(root)")),
    };
  }
  return {
    code: "job-failed",
    // Deliberately the message only: an Error's stack can carry absolute paths
    // and dependency versions, and none of that helps the developer here.
    message:
      error instanceof Error
        ? error.message
        : "The translation job failed for an unknown reason.",
  };
}

function requestErrorResponse(error: unknown): Response {
  if (error instanceof PipelineRequestError) {
    return Response.json(error.toBody(), {
      status: error.status,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return Response.json(
    {
      error: {
        code: "invalid-body" as const,
        message: "The request could not be read.",
      },
    },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}
