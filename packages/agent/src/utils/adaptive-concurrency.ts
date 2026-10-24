/**
 * A concurrency limit that adapts to the model provider: it grows by one
 * after a run of successes and halves when the provider throttles (additive
 * increase, multiplicative decrease). Every page writer of a job shares one
 * limiter, so the job's width follows the provider's real capacity.
 */

export interface AdaptiveConcurrencyPolicy {
  /** The width before any feedback. */
  start: number;
  min: number;
  /** The ceiling, set by the caller or granted by an account-wide limiter. */
  max: number;
  /** Successes at the current width before it grows by one. */
  increaseAfterSuccesses: number;
  /**
   * Throttles within this time after a decrease count as the same burst, so
   * parallel calls that fail together halve the width once.
   */
  decreaseCooldownMs: number;
}

/** Start at 8 writers, grow to at most 24, halve on a 429 or 529. */
export const DEFAULT_WRITER_WIDTH_POLICY: AdaptiveConcurrencyPolicy = {
  start: 8,
  min: 1,
  max: 24,
  increaseAfterSuccesses: 2,
  decreaseCooldownMs: 10_000,
};

/** The policy for a ceiling that a caller sets or an account limiter grants. */
export function writerWidthPolicy(
  ceiling: number,
  base: AdaptiveConcurrencyPolicy = DEFAULT_WRITER_WIDTH_POLICY,
): AdaptiveConcurrencyPolicy {
  const max = Math.max(base.min, Math.floor(ceiling));
  return { ...base, max, start: Math.min(base.start, max) };
}

export type ReleaseSlot = () => void;

export interface ConcurrencyLimiter {
  readonly width: number;
  readonly max: number;
  readonly active: number;
  /** Waits for a free slot. The returned function frees it again, once. */
  acquire(signal?: AbortSignal): Promise<ReleaseSlot>;
  recordSuccess(): void;
  recordThrottle(): void;
}

export class AdaptiveConcurrencyLimiter implements ConcurrencyLimiter {
  private currentWidth: number;
  private running = 0;
  private successesAtWidth = 0;
  private lastDecreaseAt = Number.NEGATIVE_INFINITY;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private policy: AdaptiveConcurrencyPolicy,
    private readonly now: () => number = Date.now,
  ) {
    assertPolicy(policy);
    this.currentWidth = policy.start;
  }

  get width(): number {
    return this.currentWidth;
  }

  get max(): number {
    return this.policy.max;
  }

  get active(): number {
    return this.running;
  }

  async acquire(signal?: AbortSignal): Promise<ReleaseSlot> {
    while (this.running >= this.currentWidth) {
      signal?.throwIfAborted();
      await this.waitForSlot(signal);
    }
    signal?.throwIfAborted();
    this.running += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running -= 1;
      this.wakeWaiters();
    };
  }

  /** A new ceiling, for example a new grant from an account-wide limiter. */
  setMax(max: number): void {
    const ceiling = Math.max(this.policy.min, Math.floor(max));
    this.policy = { ...this.policy, max: ceiling, start: Math.min(this.policy.start, ceiling) };
    this.currentWidth = Math.min(this.currentWidth, ceiling);
    this.wakeWaiters();
  }

  recordSuccess(): void {
    if (this.currentWidth >= this.policy.max) return;
    this.successesAtWidth += 1;
    if (this.successesAtWidth < this.policy.increaseAfterSuccesses) return;
    this.successesAtWidth = 0;
    this.currentWidth += 1;
    this.wakeWaiters();
  }

  recordThrottle(): void {
    const now = this.now();
    if (now - this.lastDecreaseAt < this.policy.decreaseCooldownMs) return;
    this.lastDecreaseAt = now;
    this.successesAtWidth = 0;
    this.currentWidth = Math.max(this.policy.min, Math.floor(this.currentWidth / 2));
  }

  private waitForSlot(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(wake);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal?.reason);
      };
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      this.waiters.push(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Each waiter checks the width again, so waking more than fit is safe. */
  private wakeWaiters(): void {
    const free = this.currentWidth - this.running;
    for (const wake of this.waiters.splice(0, Math.max(0, free))) wake();
  }
}

function assertPolicy(policy: AdaptiveConcurrencyPolicy): void {
  const { start, min, max, increaseAfterSuccesses } = policy;
  if (![start, min, max, increaseAfterSuccesses].every(Number.isInteger) || min < 1 || max < min || start < min || start > max || increaseAfterSuccesses < 1) {
    throw new RangeError(`Invalid concurrency policy: ${JSON.stringify(policy)}.`);
  }
}
