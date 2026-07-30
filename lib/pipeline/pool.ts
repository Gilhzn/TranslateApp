/**
 * A bounded concurrency pool.
 *
 * Two properties matter and both are tested:
 *
 *   1. At most `concurrency` workers are ever in flight. Locale files run to
 *      thousands of strings; dispatching every batch at once would trip the
 *      provider's rate limit on the first upload and turn a 20-second job into
 *      a cascade of 429s.
 *   2. Cancellation is prompt. Once the signal fires, no *new* task is
 *      dispatched — the in-flight ones are handed the same signal and settle on
 *      their own. That is the difference between "cancel" and "stop paying for
 *      calls two minutes from now".
 *
 * Results keep input order regardless of completion order, so callers can pair
 * `batches[i]` with `responses[i]` without threading an index through.
 */

import { JobAbortedError, isAborted } from "./errors";

export interface PoolOptions {
  signal?: AbortSignal | undefined;
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight.
 *
 * @throws the first worker rejection, after in-flight workers settle.
 * @throws {JobAbortedError} when `signal` fires before every item completed.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  options: PoolOptions = {},
): Promise<R[]> {
  const signal = options.signal;
  if (items.length === 0) {
    // An empty job is complete, not cancelled — checking the signal here would
    // make "cancel a job with nothing to do" throw.
    return [];
  }
  if (isAborted(signal)) throw new JobAbortedError();

  const results = new Array<R>(items.length);
  const limit = boundedLimit(concurrency, items.length);

  let cursor = 0;
  let completed = 0;
  let failure: { error: unknown } | null = null;

  const runner = async (): Promise<void> => {
    for (;;) {
      // Both gates are re-read every iteration: a sibling worker may have
      // failed, or the caller may have cancelled, since the last await.
      if (failure !== null || isAborted(signal)) return;
      const index = cursor;
      if (index >= items.length) return;
      cursor = index + 1;
      // `index < items.length` on a dense array, which is what every caller
      // passes; the cast avoids a `T | undefined` that could never occur.
      const item = items[index] as T;
      try {
        results[index] = await worker(item, index);
        completed += 1;
      } catch (error) {
        if (failure === null) failure = { error };
        return;
      }
    }
  };

  const runners: Array<Promise<void>> = [];
  for (let i = 0; i < limit; i += 1) runners.push(runner());
  await Promise.all(runners);

  if (failure !== null) throw failure.error;
  // Abort is only reported when it actually cost us work; a signal that fired
  // after the last item finished did not cancel anything.
  if (completed < items.length) throw new JobAbortedError();
  return results;
}

function boundedLimit(concurrency: number, itemCount: number): number {
  const requested = Number.isFinite(concurrency) ? Math.trunc(concurrency) : 1;
  return Math.max(1, Math.min(requested, itemCount));
}

/**
 * Race a promise against an abort signal.
 *
 * Used for provider calls that ignore the signal they were handed: the pool
 * stops dispatching immediately, but a task already inside a 60-second HTTP
 * timeout would otherwise hold the job open. The underlying promise is not
 * cancelled — it cannot be — but its result is discarded.
 */
export function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(new JobAbortedError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new JobAbortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
