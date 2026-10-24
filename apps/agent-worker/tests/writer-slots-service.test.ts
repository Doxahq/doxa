import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class DurableObject {
    constructor(
      protected readonly ctx: unknown,
      protected readonly env: unknown,
    ) {}
  },
}));

import type { WriterSlotLease } from "../src/writer-slots/limiter";
import { WriterSlotsDurableObject } from "../src/writer-slots/durable-object";
import {
  WRITER_SLOT_LEASES_STORAGE_KEY,
  WriterSlotsService,
  type WriterSlotLeaseStorage,
} from "../src/writer-slots/service";

const START = Date.parse("2026-10-16T12:00:00.000Z");
const TTL = 60_000;

class MemoryStorage implements WriterSlotLeaseStorage {
  readonly values = new Map<string, unknown>();
  puts = 0;

  async get(key: string): Promise<unknown> {
    return structuredClone(this.values.get(key));
  }

  async put(key: string, value: WriterSlotLease[]): Promise<void> {
    this.puts += 1;
    this.values.set(key, structuredClone(value));
  }
}

function load(storage: MemoryStorage, clock: { now: number }, ceiling = 10) {
  let nextId = 0;
  return WriterSlotsService.load(storage, {
    ceiling,
    now: () => clock.now,
    createLeaseId: () => `lease-${++nextId}`,
  });
}

describe("writer slots service", () => {
  test("persists leases and restores them after a restart", async () => {
    const storage = new MemoryStorage();
    const clock = { now: START };
    const first = await load(storage, clock);
    const lease = await first.acquire({ jobId: "job-a", requested: 8, ttlMs: TTL });

    expect(storage.values.get(WRITER_SLOT_LEASES_STORAGE_KEY)).toEqual([lease]);

    const restarted = await load(storage, clock);
    expect((await restarted.acquire({ jobId: "job-b", requested: 8, ttlMs: TTL })).granted).toBe(2);
    await restarted.release({ leaseId: lease.leaseId });
    expect(storage.values.get(WRITER_SLOT_LEASES_STORAGE_KEY)).toEqual([
      expect.objectContaining({ jobId: "job-b" }),
    ]);
  });

  test("drops expired leases on the next request", async () => {
    const storage = new MemoryStorage();
    const clock = { now: START };
    const service = await load(storage, clock);
    const lease = await service.acquire({ jobId: "job-a", requested: 10, ttlMs: TTL });
    clock.now += TTL;

    expect(await service.renew({ leaseId: lease.leaseId, ttlMs: TTL })).toBeNull();
    expect((await service.acquire({ jobId: "job-b", requested: 10, ttlMs: TTL })).granted).toBe(10);
    expect(storage.values.get(WRITER_SLOT_LEASES_STORAGE_KEY)).toEqual([
      expect.objectContaining({ jobId: "job-b" }),
    ]);
  });

  test("restores without the leases that expired while it was stopped", async () => {
    const storage = new MemoryStorage();
    const clock = { now: START };
    await (await load(storage, clock)).acquire({ jobId: "job-a", requested: 10, ttlMs: TTL });
    clock.now += TTL;

    const restarted = await load(storage, clock);
    expect((await restarted.acquire({ jobId: "job-b", requested: 10, ttlMs: TTL })).granted).toBe(10);
  });

  test("writes only when a release or renew changes a lease", async () => {
    const storage = new MemoryStorage();
    const service = await load(storage, { now: START });

    await service.release({ leaseId: "lease-unknown" });
    await service.renew({ leaseId: "lease-unknown", ttlMs: TTL });
    expect(storage.puts).toBe(0);
  });

  test("starts empty when the stored leases are unreadable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const storage = new MemoryStorage();
    storage.values.set(WRITER_SLOT_LEASES_STORAGE_KEY, [{ leaseId: 1 }]);
    const service = await load(storage, { now: START });

    expect((await service.acquire({ jobId: "job-a", requested: 10, ttlMs: TTL })).granted).toBe(10);
  });

  test("rejects an invalid request", async () => {
    const service = await load(new MemoryStorage(), { now: START });

    await expect(service.acquire({ jobId: "job-a", requested: 0, ttlMs: TTL })).rejects.toThrow();
    await expect(service.acquire({ jobId: "job-a", requested: 2, ttlMs: -1 })).rejects.toThrow();
    await expect(service.release({})).rejects.toThrow();
  });
});

describe("writer slots durable object", () => {
  test("serves the pool from its storage with the configured ceiling", async () => {
    const storage = new MemoryStorage();
    const ctx = {
      storage,
      blockConcurrencyWhile: <T>(callback: () => Promise<T>) => callback(),
    };
    const env = { DOXA_ACCOUNT_WRITER_SLOTS: "4" };
    const durableObject = new WriterSlotsDurableObject(ctx as never, env as never);

    const lease = await durableObject.acquire({ jobId: "job-a", requested: 6, ttlMs: TTL });
    expect(lease.granted).toBe(4);
    expect(await durableObject.renew({ leaseId: lease.leaseId, ttlMs: TTL })).toMatchObject({
      leaseId: lease.leaseId,
    });

    const restarted = new WriterSlotsDurableObject(ctx as never, env as never);
    expect((await restarted.acquire({ jobId: "job-b", requested: 6, ttlMs: TTL })).granted).toBe(1);
    await restarted.release({ leaseId: lease.leaseId });
    expect((await restarted.acquire({ jobId: "job-c", requested: 6, ttlMs: TTL })).granted).toBe(2);
  });
});
