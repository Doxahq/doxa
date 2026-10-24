import { describe, expect, test } from "vitest";

import { WriterSlotPool } from "../src/writer-slots/pool";

const START = Date.parse("2026-10-16T12:00:00.000Z");
const TTL = 60_000;

function createPool(ceiling = 48) {
  const clock = { now: START };
  let nextId = 0;
  const pool = new WriterSlotPool({
    ceiling,
    now: () => clock.now,
    createLeaseId: () => `lease-${++nextId}`,
  });
  return { pool, clock };
}

describe("writer slot pool", () => {
  test("grants what a job asks for when the pool has room", () => {
    const { pool } = createPool();

    expect(pool.acquire({ jobId: "job-a", requested: 24, ttlMs: TTL })).toEqual({
      leaseId: "lease-1",
      jobId: "job-a",
      granted: 24,
      expiresAt: "2026-10-16T12:01:00.000Z",
    });
  });

  test("caps a grant at the free slots", () => {
    const { pool } = createPool(10);
    pool.acquire({ jobId: "job-a", requested: 4, ttlMs: TTL });

    expect(pool.acquire({ jobId: "job-b", requested: 8, ttlMs: TTL }).granted).toBe(5);
  });

  test("grants the minimum when the pool is full, so a job never starves", () => {
    const { pool } = createPool(10);
    pool.acquire({ jobId: "job-a", requested: 5, ttlMs: TTL });
    pool.acquire({ jobId: "job-b", requested: 5, ttlMs: TTL });

    expect(pool.acquire({ jobId: "job-c", requested: 6, ttlMs: TTL }).granted).toBe(1);
    expect(pool.acquire({ jobId: "job-d", requested: 6, minimum: 2, ttlMs: TTL }).granted).toBe(2);
    // The ceiling is soft by at most the minimum of each job.
    expect(totalGranted(pool)).toBe(13);
  });

  test("never grants more than requested, even to meet the minimum", () => {
    const { pool } = createPool(10);
    pool.acquire({ jobId: "job-a", requested: 10, ttlMs: TTL });

    expect(pool.acquire({ jobId: "job-b", requested: 2, minimum: 5, ttlMs: TTL }).granted).toBe(2);
  });

  test("limits a job to its fair share of the ceiling", () => {
    const { pool } = createPool(48);
    pool.acquire({ jobId: "job-a", requested: 6, ttlMs: TTL });
    pool.acquire({ jobId: "job-b", requested: 6, ttlMs: TTL });

    // Three active jobs: ceil(48 / 3) = 16, although 36 slots are free.
    expect(pool.acquire({ jobId: "job-c", requested: 30, ttlMs: TTL }).granted).toBe(16);
  });

  test("rounds the fair share up", () => {
    const { pool } = createPool(10);
    pool.acquire({ jobId: "job-a", requested: 1, ttlMs: TTL });
    pool.acquire({ jobId: "job-b", requested: 1, ttlMs: TTL });

    expect(pool.acquire({ jobId: "job-c", requested: 8, ttlMs: TTL }).granted).toBe(4);
  });

  test("adjusts the existing lease when the same job asks again", () => {
    const { pool, clock } = createPool(10);
    pool.acquire({ jobId: "job-a", requested: 8, ttlMs: TTL });
    clock.now += 10_000;

    // The job's own 8 slots do not count as used.
    expect(pool.acquire({ jobId: "job-a", requested: 10, ttlMs: TTL })).toEqual({
      leaseId: "lease-1",
      jobId: "job-a",
      granted: 10,
      expiresAt: "2026-10-16T12:01:10.000Z",
    });
    expect(pool.leases()).toHaveLength(1);
  });

  test("frees the slots of an expired lease", () => {
    const { pool, clock } = createPool(10);
    pool.acquire({ jobId: "job-a", requested: 10, ttlMs: TTL });
    clock.now += TTL;

    expect(pool.leases()).toEqual([]);
    expect(pool.acquire({ jobId: "job-b", requested: 10, ttlMs: TTL }).granted).toBe(10);
  });

  test("returns the slots of a released lease to the pool", () => {
    const { pool } = createPool(10);
    const lease = pool.acquire({ jobId: "job-a", requested: 10, ttlMs: TTL });

    expect(pool.release(lease.leaseId)).toBe(true);
    expect(pool.acquire({ jobId: "job-b", requested: 10, ttlMs: TTL }).granted).toBe(10);
  });

  test("ignores the release of an unknown or expired lease", () => {
    const { pool, clock } = createPool(10);
    const lease = pool.acquire({ jobId: "job-a", requested: 4, ttlMs: TTL });
    pool.acquire({ jobId: "job-b", requested: 4, ttlMs: TTL * 2 });

    expect(pool.release("lease-unknown")).toBe(false);
    clock.now += TTL;
    expect(pool.release(lease.leaseId)).toBe(false);
    expect(pool.leases().map((held) => held.jobId)).toEqual(["job-b"]);
  });

  test("extends a live lease and refuses an expired one", () => {
    const { pool, clock } = createPool(10);
    const lease = pool.acquire({ jobId: "job-a", requested: 4, ttlMs: TTL });
    clock.now += 30_000;

    expect(pool.renew(lease.leaseId, TTL)).toEqual({
      ...lease,
      expiresAt: "2026-10-16T12:01:30.000Z",
    });
    clock.now += TTL;
    expect(pool.renew(lease.leaseId, TTL)).toBeNull();
    expect(pool.renew("lease-unknown", TTL)).toBeNull();
  });

  test("restores leases and counts them as used", () => {
    const pool = new WriterSlotPool({
      ceiling: 10,
      now: () => START,
      createLeaseId: () => "lease-new",
      leases: [
        { leaseId: "lease-old", jobId: "job-a", granted: 7, expiresAt: "2026-10-16T12:05:00.000Z" },
        { leaseId: "lease-gone", jobId: "job-b", granted: 3, expiresAt: "2026-10-16T11:59:00.000Z" },
      ],
    });

    expect(pool.leases().map((lease) => lease.leaseId)).toEqual(["lease-old"]);
    expect(pool.acquire({ jobId: "job-c", requested: 5, ttlMs: TTL }).granted).toBe(3);
  });

  test("rejects a ceiling that is not a positive integer", () => {
    expect(() => createPool(0)).toThrow(RangeError);
    expect(() => createPool(2.5)).toThrow(RangeError);
  });
});

function totalGranted(pool: WriterSlotPool): number {
  return pool.leases().reduce((total, lease) => total + lease.granted, 0);
}
