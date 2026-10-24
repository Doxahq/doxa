import { z } from "zod";

/** The longest lease a caller may ask for. A longer write group renews. */
export const MAX_WRITER_SLOT_TTL_MS = 2 * 60 * 60 * 1000;

/** Writer slots held by one generation job until `expiresAt`. */
export interface WriterSlotLease {
  leaseId: string;
  jobId: string;
  granted: number;
  /** ISO timestamp. After it the slots return to the pool without a release. */
  expiresAt: string;
}

export interface WriterSlotAcquireInput {
  jobId: string;
  /** The page concurrency the job wants. */
  requested: number;
  /**
   * The grant the job always gets, even when the pool is full. Default 1.
   * Capped at `requested`.
   */
  minimum?: number;
  ttlMs: number;
}

/**
 * Hands out the account-wide model writer slots. A job asks for slots before
 * it sends a write group, uses `granted` as the group's page concurrency, and
 * releases the lease when the group ends.
 */
export interface WriterSlotLimiter {
  acquire(input: WriterSlotAcquireInput): Promise<WriterSlotLease>;
  /** Releasing an unknown or expired lease does nothing. */
  release(leaseId: string): Promise<void>;
  /** Extends a live lease. Returns null when the lease is gone or expired. */
  renew?(leaseId: string, ttlMs: number): Promise<WriterSlotLease | null>;
}

const slotCountSchema = z.number().int().positive();
const leaseIdSchema = z.string().min(1);
const ttlMsSchema = z.number().int().positive().max(MAX_WRITER_SLOT_TTL_MS);

export const writerSlotLeaseSchema = z.object({
  leaseId: leaseIdSchema,
  jobId: z.string().min(1),
  granted: slotCountSchema,
  expiresAt: z.iso.datetime(),
});

export const writerSlotAcquireRequestSchema = z.object({
  jobId: z.string().min(1),
  requested: slotCountSchema,
  minimum: slotCountSchema.default(1),
  ttlMs: ttlMsSchema,
});

export const writerSlotReleaseRequestSchema = z.object({
  leaseId: leaseIdSchema,
});

export const writerSlotRenewRequestSchema = z.object({
  leaseId: leaseIdSchema,
  ttlMs: ttlMsSchema,
});

export const writerSlotRenewResponseSchema = writerSlotLeaseSchema.nullable();

export type WriterSlotAcquireRequest = z.input<typeof writerSlotAcquireRequestSchema>;
export type WriterSlotReleaseRequest = z.infer<typeof writerSlotReleaseRequestSchema>;
export type WriterSlotRenewRequest = z.infer<typeof writerSlotRenewRequestSchema>;
