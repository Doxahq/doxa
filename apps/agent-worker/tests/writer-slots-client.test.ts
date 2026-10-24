import { describe, expect, test, vi } from "vitest";

import type { Env } from "../src/index";
import {
  DEFAULT_ACCOUNT_WRITER_SLOTS,
  WRITER_SLOTS_INSTANCE_NAME,
  createDurableObjectWriterSlotLimiter,
  noopWriterSlotLimiter,
  parseAccountWriterSlots,
  resolveWriterSlotLimiter,
  type WriterSlotLease,
  type WriterSlotsEnv,
  type WriterSlotsNamespace,
  type WriterSlotsRpc,
} from "../src/writer-slots";

// Compile-time check: the worker `Env`, with the real binding type, fits the resolver.
const envFitsResolver: (env: Env) => WriterSlotsEnv = (env) => env;
void envFitsResolver;

const START = Date.parse("2026-10-16T12:00:00.000Z");
const lease: WriterSlotLease = {
  leaseId: "lease-1",
  jobId: "job-a",
  granted: 6,
  expiresAt: "2026-10-16T12:01:00.000Z",
};

function createNamespace(stub: WriterSlotsRpc) {
  const idFromName = vi.fn((name: string): DurableObjectId => ({
    name,
    toString: () => `id:${name}`,
    equals: (other) => other.name === name,
  }));
  const get = vi.fn((_id: DurableObjectId) => stub);
  const namespace: WriterSlotsNamespace = { idFromName, get };
  return { namespace, idFromName, get };
}

function createStub(overrides: Partial<WriterSlotsRpc> = {}): WriterSlotsRpc {
  return {
    acquire: vi.fn(async () => lease),
    release: vi.fn(async () => undefined),
    renew: vi.fn(async () => lease),
    ...overrides,
  };
}

describe("durable object writer slot limiter", () => {
  test("sends typed requests to the one account instance", async () => {
    const stub = createStub();
    const { namespace, idFromName, get } = createNamespace(stub);
    const limiter = createDurableObjectWriterSlotLimiter(namespace);

    await expect(limiter.acquire({ jobId: "job-a", requested: 6, minimum: 2, ttlMs: 60_000 }))
      .resolves.toEqual(lease);
    await limiter.release("lease-1");
    await expect(limiter.renew?.("lease-1", 30_000)).resolves.toEqual(lease);

    expect(idFromName).toHaveBeenCalledWith(WRITER_SLOTS_INSTANCE_NAME);
    expect(get.mock.calls[0]?.[0].name).toBe("account");
    expect(stub.acquire).toHaveBeenCalledWith({ jobId: "job-a", requested: 6, minimum: 2, ttlMs: 60_000 });
    expect(stub.release).toHaveBeenCalledWith({ leaseId: "lease-1" });
    expect(stub.renew).toHaveBeenCalledWith({ leaseId: "lease-1", ttlMs: 30_000 });
  });

  test("returns null when the lease to renew is gone", async () => {
    const { namespace } = createNamespace(createStub({ renew: vi.fn(async () => null) }));

    await expect(createDurableObjectWriterSlotLimiter(namespace).renew?.("lease-1", 30_000))
      .resolves.toBeNull();
  });

  test("rejects a malformed response", async () => {
    const { namespace } = createNamespace(createStub({
      acquire: vi.fn(async () => ({ ...lease, granted: 0 })),
    }));

    await expect(createDurableObjectWriterSlotLimiter(namespace)
      .acquire({ jobId: "job-a", requested: 6, ttlMs: 60_000 })).rejects.toThrow();
  });
});

describe("no-op writer slot limiter", () => {
  test("grants the request up to the ceiling", async () => {
    const limiter = noopWriterSlotLimiter(8, { now: () => START });

    await expect(limiter.acquire({ jobId: "job-a", requested: 24, ttlMs: 60_000 })).resolves.toEqual({
      leaseId: "noop:job-a",
      jobId: "job-a",
      granted: 8,
      expiresAt: "2026-10-16T12:01:00.000Z",
    });
    expect((await limiter.acquire({ jobId: "job-b", requested: 3, ttlMs: 60_000 })).granted).toBe(3);
    await expect(limiter.release("noop:job-a")).resolves.toBeUndefined();
    expect(limiter.renew).toBeUndefined();
  });
});

describe("writer slot configuration", () => {
  test("reads a positive integer ceiling", () => {
    expect(parseAccountWriterSlots("24")).toBe(24);
  });

  test.each([undefined, "", "0", "-4", "12.5", "many"])("uses the default for %j", (value) => {
    expect(parseAccountWriterSlots(value)).toBe(DEFAULT_ACCOUNT_WRITER_SLOTS);
  });

  test("defaults to 48 slots", () => {
    expect(DEFAULT_ACCOUNT_WRITER_SLOTS).toBe(48);
  });
});

describe("writer slot limiter resolver", () => {
  test("uses the durable object when the binding exists", async () => {
    const stub = createStub();
    const { namespace } = createNamespace(stub);

    await resolveWriterSlotLimiter({ WRITER_SLOTS: namespace }).acquire({
      jobId: "job-a",
      requested: 6,
      ttlMs: 60_000,
    });
    expect(stub.acquire).toHaveBeenCalledOnce();
  });

  test("falls back to the no-op limiter with the configured ceiling", async () => {
    const limiter = resolveWriterSlotLimiter({ DOXA_ACCOUNT_WRITER_SLOTS: "5" });

    const granted = await limiter.acquire({ jobId: "job-a", requested: 24, ttlMs: 60_000 });
    expect(granted).toMatchObject({ leaseId: "noop:job-a", granted: 5 });
  });
});

describe("writer slots in the workflow", () => {
  test("a limiter that cannot answer gives the job its ceiling instead of failing the group", async () => {
    const { acquireWriterSlots } = await import("../src/generation-workflow-runtime");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failing = {
      acquire: async () => {
        throw new Error("Durable Object unavailable");
      },
      release: async () => undefined,
    };

    await expect(acquireWriterSlots(failing, { jobId: "job-1", requested: 24, ttlMs: 60_000 }))
      .resolves.toEqual({ leaseId: null, granted: 24 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"eventType":"writer_slots_unavailable"'));
    warn.mockRestore();
  });

  test("the slots of a job are released once, after its write groups", async () => {
    const { releaseWriterSlotLeases } = await import("../src/generation-workflow-runtime");
    const released: string[] = [];
    await releaseWriterSlotLeases(
      { acquire: async () => ({ leaseId: "x", jobId: "j", granted: 1, expiresAt: "" }), release: async (id) => { released.push(id); } },
      [
        { status: "fulfilled", value: { writerSlotLeaseId: "lease-1" } },
        { status: "fulfilled", value: { writerSlotLeaseId: "lease-1" } },
        { status: "fulfilled", value: { writerSlotLeaseId: null } },
        { status: "rejected", reason: new Error("failed") },
      ],
    );
    expect(released).toEqual(["lease-1"]);
  });
});
