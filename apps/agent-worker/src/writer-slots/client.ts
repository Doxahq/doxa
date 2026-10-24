import { parseAccountWriterSlots } from "./config";
import {
  writerSlotLeaseSchema,
  writerSlotRenewResponseSchema,
  type WriterSlotAcquireRequest,
  type WriterSlotLimiter,
  type WriterSlotReleaseRequest,
  type WriterSlotRenewRequest,
} from "./limiter";

/** The name of the one Durable Object instance that holds the account pool. */
export const WRITER_SLOTS_INSTANCE_NAME = "account";

/** The RPC methods of `WriterSlotsDurableObject`. Results are parsed, not trusted. */
export interface WriterSlotsRpc {
  acquire(request: WriterSlotAcquireRequest): Promise<unknown>;
  release(request: WriterSlotReleaseRequest): Promise<unknown>;
  renew(request: WriterSlotRenewRequest): Promise<unknown>;
}

/** The part of a Durable Object namespace binding the client uses. */
export interface WriterSlotsNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): WriterSlotsRpc;
}

export function createDurableObjectWriterSlotLimiter(
  namespace: WriterSlotsNamespace,
): WriterSlotLimiter {
  const pool = () => namespace.get(namespace.idFromName(WRITER_SLOTS_INSTANCE_NAME));
  return {
    acquire: async (input) => writerSlotLeaseSchema.parse(await pool().acquire(input)),
    release: async (leaseId) => {
      await pool().release({ leaseId });
    },
    renew: async (leaseId, ttlMs) =>
      writerSlotRenewResponseSchema.parse(await pool().renew({ leaseId, ttlMs })),
  };
}

export interface NoopWriterSlotLimiterOptions {
  now?: () => number;
}

/**
 * Grants what a job asks for, up to `ceiling`, and keeps no state. For local
 * development and for a deploy without the `WRITER_SLOTS` binding.
 */
export function noopWriterSlotLimiter(
  ceiling: number,
  options: NoopWriterSlotLimiterOptions = {},
): WriterSlotLimiter {
  const now = options.now ?? Date.now;
  return {
    acquire: async (input) => ({
      leaseId: `noop:${input.jobId}`,
      jobId: input.jobId,
      granted: Math.max(1, Math.min(input.requested, ceiling)),
      expiresAt: new Date(now() + input.ttlMs).toISOString(),
    }),
    release: async () => undefined,
  };
}

/** The part of the worker `Env` the resolver reads. */
export interface WriterSlotsEnv {
  WRITER_SLOTS?: WriterSlotsNamespace;
  DOXA_ACCOUNT_WRITER_SLOTS?: string;
}

/** The Durable Object limiter when the binding exists, else the no-op limiter. */
export function resolveWriterSlotLimiter(env: WriterSlotsEnv): WriterSlotLimiter {
  if (env.WRITER_SLOTS) return createDurableObjectWriterSlotLimiter(env.WRITER_SLOTS);
  return noopWriterSlotLimiter(parseAccountWriterSlots(env.DOXA_ACCOUNT_WRITER_SLOTS));
}
