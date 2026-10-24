import { describe, expect, test } from "vitest";
import { createGate, mapWithConcurrency } from "../src/utils/concurrency";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("mapWithConcurrency", () => {
  test("never exceeds the configured in-flight limit", async () => {
    const pending = Array.from({ length: 6 }, () => deferred<number>());
    let inFlight = 0;
    let maxInFlight = 0;

    const result = mapWithConcurrency(
      pending,
      async (item) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await item.promise;
        } finally {
          inFlight -= 1;
        }
      },
      { concurrency: 2 },
    );

    await flushMicrotasks();
    expect(maxInFlight).toBe(2);
    for (let index = 0; index < pending.length; index += 1) {
      pending[index]?.resolve(index);
      await flushMicrotasks();
      expect(maxInFlight).toBe(2);
    }
    await result;
  });

  test("starts later items whenever any worker settles", async () => {
    const pending = Array.from({ length: 5 }, () => deferred<number>());
    const started: number[] = [];
    const result = mapWithConcurrency(
      pending,
      async (item, index) => {
        started.push(index);
        return item.promise;
      },
      { concurrency: 2 },
    );

    await flushMicrotasks();
    expect(started).toEqual([0, 1]);

    pending[1]?.resolve(1);
    await flushMicrotasks();
    expect(started).toEqual([0, 1, 2]);
    pending[2]?.resolve(2);
    await flushMicrotasks();
    expect(started).toEqual([0, 1, 2, 3]);
    pending[3]?.resolve(3);
    await flushMicrotasks();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(started).toContain(4);

    pending[0]?.resolve(0);
    pending[4]?.resolve(4);
    await result;
  });

  test("returns fulfilled and rejected results in input order", async () => {
    const results = await mapWithConcurrency(
      [0, 1, 2, 3],
      async (item) => {
        if (item === 1 || item === 3) {
          throw new Error(`failed-${item}`);
        }
        return item * 10;
      },
      { concurrency: 3 },
    );

    expect(results).toEqual([
      { status: "fulfilled", value: 0 },
      { status: "rejected", reason: expect.objectContaining({ message: "failed-1" }) },
      { status: "fulfilled", value: 20 },
      { status: "rejected", reason: expect.objectContaining({ message: "failed-3" }) },
    ]);
  });

  test("stops scheduling after abort and rejects unstarted items", async () => {
    const abortController = new AbortController();
    const pending = Array.from({ length: 5 }, () => deferred<number>());
    const started: number[] = [];
    const reason = new Error("generation cancelled");
    const result = mapWithConcurrency(
      pending,
      async (item, index) => {
        started.push(index);
        return item.promise;
      },
      { concurrency: 2, abortController },
    );

    await flushMicrotasks();
    abortController.abort(reason);
    pending[0]?.resolve(0);
    pending[1]?.resolve(1);
    const settled = await result;

    expect(started).toEqual([0, 1]);
    expect(settled.slice(2)).toEqual([
      { status: "rejected", reason },
      { status: "rejected", reason },
      { status: "rejected", reason },
    ]);
  });
});

describe("mapWithConcurrency fan-out gate", () => {
  test("starts the other items only after the gate opens", async () => {
    const gate = createGate();
    const started: number[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const result = mapWithConcurrency(
      [0, 1, 2],
      async (item) => {
        started.push(item);
        if (item === 0) await firstDone;
        return item;
      },
      { concurrency: 3, fanOutAfter: gate.opened },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([0]);

    gate.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([0, 1, 2]);

    releaseFirst();
    await expect(result).resolves.toHaveLength(3);
  });

  test("fans out when the first item ends before the gate opens", async () => {
    const neverOpens = new Promise<void>(() => undefined);
    const results = await mapWithConcurrency(
      [0, 1, 2],
      async (item) => item * 2,
      { concurrency: 3, fanOutAfter: neverOpens },
    );
    expect(results).toEqual([
      { status: "fulfilled", value: 0 },
      { status: "fulfilled", value: 2 },
      { status: "fulfilled", value: 4 },
    ]);
  });
});
