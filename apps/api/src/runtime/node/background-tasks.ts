/**
 * `waitUntil` for a long-running process. Workers keep an invocation alive
 * until its `waitUntil` promises settle. Node keeps running anyway, so this
 * only has to remember the open work, log its failures, and let shutdown
 * wait for it.
 */
export class BackgroundTasks {
  private readonly pending = new Set<Promise<void>>();

  /** Runs `work` to its end. A failure is logged, never thrown. */
  track(work: Promise<unknown>): void {
    const settled: Promise<void> = work.then(
      () => undefined,
      (cause: unknown) => {
        console.error("A background task failed.", cause);
      },
    );
    this.pending.add(settled);
    void settled.finally(() => this.pending.delete(settled));
  }

  /** The number of tasks that have not settled yet. */
  get size(): number {
    return this.pending.size;
  }

  /** An execution context whose `waitUntil` adds to these tasks. */
  createExecutionContext(): ExecutionContext {
    const props = {};
    return {
      waitUntil: (promise: Promise<unknown>) => this.track(promise),
      passThroughOnException: () => {},
      props,
    };
  }

  /** Waits until no task is open, also tasks added meanwhile. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(this.pending);
    }
  }

  /**
   * Waits until no task is open, also tasks added meanwhile, or until the
   * timeout. Returns true when every task settled.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await Promise.race([Promise.all(this.pending), delay(remaining)]);
    }
    return true;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
