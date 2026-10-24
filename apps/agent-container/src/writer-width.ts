import {
  AdaptiveConcurrencyLimiter,
  writerWidthPolicy,
  type ModelCallRetryEvent,
} from "@doxahq/agent";

/**
 * One writer limiter per job. The worker can send several write groups of a
 * job to this container at once; they share the width, so the job never
 * runs more writers than its ceiling.
 */
const limiterByJob = new Map<string, AdaptiveConcurrencyLimiter>();

export function writerLimiterForJob(jobId: string, ceiling: number): AdaptiveConcurrencyLimiter {
  const existing = limiterByJob.get(jobId);
  if (existing) {
    if (existing.max !== ceiling) existing.setMax(ceiling);
    return existing;
  }
  const limiter = new AdaptiveConcurrencyLimiter(writerWidthPolicy(ceiling));
  limiterByJob.set(jobId, limiter);
  return limiter;
}

/** Drops the limiter of a job whose last write group ended. */
export function releaseWriterLimiter(jobId: string): void {
  const limiter = limiterByJob.get(jobId);
  if (limiter && limiter.active === 0) limiterByJob.delete(jobId);
}

/** A rate limit or an overload means the provider wants fewer calls. */
export function throttleOnRetry(
  limiter: AdaptiveConcurrencyLimiter,
): (retry: ModelCallRetryEvent) => void {
  return (retry) => {
    if (retry.errorClass === "rate_limited" || retry.errorClass === "overloaded") {
      limiter.recordThrottle();
    }
  };
}
