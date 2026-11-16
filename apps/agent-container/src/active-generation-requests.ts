const CANCELLATION_REASON = "Generation cancelled by user.";
const CANCELLATION_TOMBSTONE_TTL_MS = 15 * 60_000;

export class ActiveGenerationRequests {
  private readonly controllers = new Map<string, Set<AbortController>>();
  private readonly cancelledUntil = new Map<string, number>();

  register(jobId: string, controller: AbortController): boolean {
    this.removeExpiredTombstones();
    if (this.cancelledUntil.has(jobId)) {
      controller.abort(new Error(CANCELLATION_REASON));
      return false;
    }

    const controllers = this.controllers.get(jobId) ?? new Set();
    controllers.add(controller);
    this.controllers.set(jobId, controllers);
    return true;
  }

  unregister(jobId: string, controller: AbortController): void {
    const controllers = this.controllers.get(jobId);
    if (!controllers) return;

    controllers.delete(controller);
    if (controllers.size === 0) {
      this.controllers.delete(jobId);
    }
  }

  /** Aborts the job's requests and refuses its next requests for 15 minutes. */
  cancel(jobId: string): boolean {
    this.removeExpiredTombstones();
    this.cancelledUntil.set(jobId, Date.now() + CANCELLATION_TOMBSTONE_TTL_MS);
    return this.abortActive(jobId);
  }

  /**
   * Aborts the job's requests, but accepts its next request: the job can
   * continue later (a credit stop or a failed step).
   */
  stop(jobId: string): boolean {
    return this.abortActive(jobId);
  }

  private abortActive(jobId: string): boolean {
    const controllers = this.controllers.get(jobId);
    if (!controllers || controllers.size === 0) return false;

    for (const controller of controllers) {
      if (!controller.signal.aborted) {
        controller.abort(new Error(CANCELLATION_REASON));
      }
    }
    return true;
  }

  private removeExpiredTombstones(): void {
    const now = Date.now();
    for (const [jobId, expiresAt] of this.cancelledUntil) {
      if (expiresAt <= now) this.cancelledUntil.delete(jobId);
    }
  }
}
