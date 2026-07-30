import { describe, expect, it } from "vitest";
import { JobAbortedError } from "./errors";
import { mapPool, withAbort } from "./pool";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("mapPool", () => {
  it("returns results in input order regardless of completion order", async () => {
    const items = [40, 10, 30, 0, 20];
    const results = await mapPool(items, 3, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item));
      return item * 2;
    });
    expect(results).toEqual([80, 20, 60, 0, 40]);
  });

  it("never exceeds the concurrency bound", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 25 }, (_, i) => i);

    await mapPool(items, 4, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, item % 3));
      inFlight -= 1;
      return item;
    });

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("caps the worker count at the item count", async () => {
    let peak = 0;
    let inFlight = 0;
    await mapPool([1, 2], 16, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return item;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("stops dispatching new work once the signal fires", async () => {
    const controller = new AbortController();
    const started: number[] = [];
    const items = Array.from({ length: 20 }, (_, i) => i);

    const run = mapPool(
      items,
      2,
      async (item) => {
        started.push(item);
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (item === 1) controller.abort();
        return item;
      },
      { signal: controller.signal },
    );

    await expect(run).rejects.toBeInstanceOf(JobAbortedError);
    // The two in-flight tasks finish; nothing after them is dispatched.
    expect(started.length).toBeLessThanOrEqual(4);
    expect(started.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;

    await expect(
      mapPool(
        [1, 2, 3],
        2,
        async (item) => {
          called = true;
          return item;
        },
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(JobAbortedError);
    expect(called).toBe(false);
  });

  it("treats an empty item list as complete, not cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      mapPool([], 4, async (item: number) => item, { signal: controller.signal }),
    ).resolves.toEqual([]);
  });

  it("does not report an abort that landed after the last item finished", async () => {
    const controller = new AbortController();
    const results = await mapPool(
      [1, 2],
      2,
      async (item) => {
        if (item === 2) controller.abort();
        return item;
      },
      { signal: controller.signal },
    );
    expect(results).toEqual([1, 2]);
  });

  it("propagates the first worker rejection and stops dispatching", async () => {
    const started: number[] = [];
    const items = Array.from({ length: 12 }, (_, i) => i);

    await expect(
      mapPool(items, 2, async (item) => {
        started.push(item);
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (item === 0) throw new Error("boom");
        return item;
      }),
    ).rejects.toThrow("boom");

    expect(started.length).toBeLessThan(items.length);
  });
});

describe("withAbort", () => {
  it("resolves with the underlying value when nothing aborts", async () => {
    const controller = new AbortController();
    await expect(withAbort(Promise.resolve(7), controller.signal)).resolves.toBe(7);
  });

  it("rejects as soon as the signal fires, without waiting for the promise", async () => {
    const controller = new AbortController();
    const pending = deferred<number>();
    const raced = withAbort(pending.promise, controller.signal);
    controller.abort();
    await expect(raced).rejects.toBeInstanceOf(JobAbortedError);
    pending.resolve(1);
  });

  it("passes the promise straight through with no signal", async () => {
    const promise = Promise.resolve("x");
    expect(withAbort(promise, undefined)).toBe(promise);
  });
});
