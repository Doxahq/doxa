import type { WriterSlotAcquireInput, WriterSlotLease } from "./limiter";

export interface WriterSlotPoolOptions {
  /** The account-wide number of writer slots. */
  ceiling: number;
  /** Milliseconds since the epoch. */
  now: () => number;
  createLeaseId?: () => string;
  /** Leases to restore, for example after a Durable Object restart. */
  leases?: readonly WriterSlotLease[];
}

interface HeldLease {
  leaseId: string;
  jobId: string;
  granted: number;
  expiresAtMs: number;
}

/**
 * The allocation rules of the writer slot limiter, with no I/O.
 *
 * - A job gets `min(requested, free slots, fair share)`, but never less than
 *   `minimum` (default 1, capped at `requested`). So a job never starves
 *   while the pool is full, and the ceiling is soft by at most `minimum`
 *   slots per job.
 * - Fair share is `ceil(ceiling / active jobs)`, where the active jobs are
 *   the jobs that hold a live lease plus the job that asks. It only limits a
 *   new grant; it never takes slots back from a lease.
 * - A job has at most one lease. When it asks again, its lease keeps its ID
 *   and gets a new grant and expiry; its old grant does not count as used.
 * - A lease expires `ttlMs` after its last acquire or renew, so a crashed job
 *   cannot hold slots forever. Every call first drops the expired leases.
 */
export class WriterSlotPool {
  readonly ceiling: number;
  private readonly now: () => number;
  private readonly createLeaseId: () => string;
  private readonly leasesByJob = new Map<string, HeldLease>();

  constructor(options: WriterSlotPoolOptions) {
    if (!Number.isInteger(options.ceiling) || options.ceiling < 1) {
      throw new RangeError("The writer slot ceiling must be a positive integer.");
    }
    this.ceiling = options.ceiling;
    this.now = options.now;
    this.createLeaseId = options.createLeaseId ?? (() => crypto.randomUUID());
    for (const lease of options.leases ?? []) {
      this.leasesByJob.set(lease.jobId, {
        leaseId: lease.leaseId,
        jobId: lease.jobId,
        granted: lease.granted,
        expiresAtMs: Date.parse(lease.expiresAt),
      });
    }
  }

  acquire(input: WriterSlotAcquireInput): WriterSlotLease {
    const now = this.dropExpired();
    const existing = this.leasesByJob.get(input.jobId);
    const others = [...this.leasesByJob.values()].filter((lease) => lease.jobId !== input.jobId);
    const used = others.reduce((total, lease) => total + lease.granted, 0);
    const free = Math.max(0, this.ceiling - used);
    const fairShare = Math.ceil(this.ceiling / (others.length + 1));
    const floor = Math.min(input.minimum ?? 1, input.requested);
    const lease: HeldLease = {
      leaseId: existing?.leaseId ?? this.createLeaseId(),
      jobId: input.jobId,
      granted: Math.max(floor, Math.min(input.requested, free, fairShare)),
      expiresAtMs: now + input.ttlMs,
    };
    this.leasesByJob.set(input.jobId, lease);
    return toLease(lease);
  }

  /** Returns false when the lease is unknown or already expired. */
  release(leaseId: string): boolean {
    this.dropExpired();
    const lease = this.findLease(leaseId);
    if (!lease) return false;
    this.leasesByJob.delete(lease.jobId);
    return true;
  }

  /** Returns null when the lease is unknown or already expired. */
  renew(leaseId: string, ttlMs: number): WriterSlotLease | null {
    const now = this.dropExpired();
    const lease = this.findLease(leaseId);
    if (!lease) return null;
    lease.expiresAtMs = now + ttlMs;
    return toLease(lease);
  }

  /** The live leases, for persistence and observability. */
  leases(): WriterSlotLease[] {
    this.dropExpired();
    return [...this.leasesByJob.values()].map(toLease);
  }

  private findLease(leaseId: string): HeldLease | undefined {
    return [...this.leasesByJob.values()].find((lease) => lease.leaseId === leaseId);
  }

  private dropExpired(): number {
    const now = this.now();
    for (const [jobId, lease] of this.leasesByJob) {
      if (lease.expiresAtMs <= now) this.leasesByJob.delete(jobId);
    }
    return now;
  }
}

function toLease(lease: HeldLease): WriterSlotLease {
  return {
    leaseId: lease.leaseId,
    jobId: lease.jobId,
    granted: lease.granted,
    expiresAt: new Date(lease.expiresAtMs).toISOString(),
  };
}
