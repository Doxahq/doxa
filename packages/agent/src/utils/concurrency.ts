export interface MapWithConcurrencyOptions {
  concurrency: number;
  abortController?: AbortController;
  /** Invoked in completion order; use for progress counters. */
  onSettled?: (index: number) => void;
  /**
   * Starts the first item alone. The other workers start when this promise
   * settles or the first item ends, whichever is first. A prompt cache
   * written by the first call can then serve the parallel calls.
   */
  fanOutAfter?: Promise<unknown>;
}

export type SettledMapResult<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function validateConcurrency(concurrency: number): void {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(
      `Concurrency must be a positive integer; received ${concurrency}.`,
    );
  }
}

/**
 * Runs `worker` over `items` with at most `concurrency` operations in flight.
 * Results are returned in input order regardless of completion order.
 * Worker failures are captured per item instead of rejecting the pool.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  options: MapWithConcurrencyOptions,
): Promise<Array<SettledMapResult<R>>> {
  validateConcurrency(options.concurrency);

  const entries = Array.from(items.entries());
  const results: Array<SettledMapResult<R> | undefined> = Array.from(
    { length: items.length },
    () => undefined,
  );
  const signal = options.abortController?.signal;
  let nextEntryIndex = 0;
  const firstItem = createGate();

  const runWorker = async (workerIndex: number): Promise<void> => {
    if (workerIndex > 0 && options.fanOutAfter) {
      await Promise.race([options.fanOutAfter.catch(() => undefined), firstItem.opened]);
    }
    while (!signal?.aborted) {
      const entry = entries[nextEntryIndex];
      if (!entry) return;
      nextEntryIndex += 1;

      const [index, item] = entry;
      try {
        results[index] = {
          status: "fulfilled",
          value: await worker(item, index),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
      firstItem.open();
      try {
        options.onSettled?.(index);
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };

  const workerCount = Math.min(options.concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, (_, workerIndex) => runWorker(workerIndex)),
  );

  const unstartedReason = signal?.aborted
    ? abortReason(signal)
    : new Error("Concurrency worker exited before scheduling this item.");

  return results.map(
    (result): SettledMapResult<R> =>
      result ?? { status: "rejected", reason: unstartedReason },
  );
}

export interface Gate {
  readonly opened: Promise<void>;
  open(): void;
}

/** A promise that someone else resolves once. Opening it again does nothing. */
export function createGate(): Gate {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}
