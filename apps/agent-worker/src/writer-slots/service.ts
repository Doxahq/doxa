import {
  writerSlotAcquireRequestSchema,
  writerSlotLeaseSchema,
  writerSlotReleaseRequestSchema,
  writerSlotRenewRequestSchema,
  type WriterSlotLease,
} from "./limiter";
import { WriterSlotPool } from "./pool";

/** All leases are stored under one key: there are few, and one write keeps them consistent. */
export const WRITER_SLOT_LEASES_STORAGE_KEY = "leases";

/** The part of Durable Object storage the service uses. */
export interface WriterSlotLeaseStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: WriterSlotLease[]): Promise<void>;
}

export interface WriterSlotsServiceOptions {
  ceiling: number;
  now?: () => number;
  createLeaseId?: () => string;
}

const storedLeasesSchema = writerSlotLeaseSchema.array();

/**
 * A `WriterSlotPool` kept in memory and written to storage after each change,
 * so a restart keeps the leases. It validates each request, because requests
 * cross the RPC boundary. Expired leases are dropped lazily on each call.
 */
export class WriterSlotsService {
  private constructor(
    private readonly pool: WriterSlotPool,
    private readonly storage: WriterSlotLeaseStorage,
  ) {}

  static async load(
    storage: WriterSlotLeaseStorage,
    options: WriterSlotsServiceOptions,
  ): Promise<WriterSlotsService> {
    const pool = new WriterSlotPool({
      ceiling: options.ceiling,
      now: options.now ?? Date.now,
      createLeaseId: options.createLeaseId,
      leases: readStoredLeases(await storage.get(WRITER_SLOT_LEASES_STORAGE_KEY)),
    });
    return new WriterSlotsService(pool, storage);
  }

  async acquire(request: unknown): Promise<WriterSlotLease> {
    const lease = this.pool.acquire(writerSlotAcquireRequestSchema.parse(request));
    await this.persist();
    return lease;
  }

  async release(request: unknown): Promise<void> {
    const { leaseId } = writerSlotReleaseRequestSchema.parse(request);
    if (this.pool.release(leaseId)) await this.persist();
  }

  async renew(request: unknown): Promise<WriterSlotLease | null> {
    const { leaseId, ttlMs } = writerSlotRenewRequestSchema.parse(request);
    const lease = this.pool.renew(leaseId, ttlMs);
    if (lease) await this.persist();
    return lease;
  }

  private persist(): Promise<void> {
    return this.storage.put(WRITER_SLOT_LEASES_STORAGE_KEY, this.pool.leases());
  }
}

/** Unreadable stored leases start an empty pool, so a bad value cannot block every job. */
function readStoredLeases(raw: unknown): WriterSlotLease[] {
  if (raw === undefined) return [];
  const parsed = storedLeasesSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  console.error(JSON.stringify({
    service: "doxa-agent-worker",
    eventType: "writer_slot_leases_unreadable",
    error: parsed.error.message,
  }));
  return [];
}
