import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env";
import { CRON_LEASE_KEY, createValkeyCronLock, type CronLeaseStore } from "../../../src/runtime/node/cron-lease";

const env = {} as Env;

/** An in-memory store with the SET NX and compare-and-delete behavior of Valkey. */
function memoryStore() {
  const values = new Map<string, string>();
  const store: CronLeaseStore = {
    set: vi.fn(async (key: string, value: string) => {
      if (values.has(key)) return null;
      values.set(key, value);
      return "OK" as const;
    }),
    eval: vi.fn(async (_script: string, _numKeys: number, key: string, token: string) => {
      if (values.get(key) !== token) return 0;
      values.delete(key);
      return 1;
    }) as CronLeaseStore["eval"],
  };
  return { store, values };
}

describe("createValkeyCronLock", () => {
  it("runs the work under a lease with a TTL, then releases it", async () => {
    const { store, values } = memoryStore();
    const lock = createValkeyCronLock(store, { ttlMs: 60_000, newToken: () => "token-a" });
    let heldDuringWork: string | undefined;

    const ran = await lock(env, async () => {
      heldDuringWork = values.get(CRON_LEASE_KEY);
    });

    expect(ran).toBe(true);
    expect(heldDuringWork).toBe("token-a");
    expect(store.set).toHaveBeenCalledWith(CRON_LEASE_KEY, "token-a", "PX", 60_000, "NX");
    expect(values.has(CRON_LEASE_KEY)).toBe(false);
  });

  it("skips the work while another holder has the lease, and keeps that lease", async () => {
    const { store, values } = memoryStore();
    values.set(CRON_LEASE_KEY, "other-task");
    const work = vi.fn(async () => {});

    const ran = await createValkeyCronLock(store, { newToken: () => "token-b" })(env, work);

    expect(ran).toBe(false);
    expect(work).not.toHaveBeenCalled();
    expect(values.get(CRON_LEASE_KEY)).toBe("other-task");
  });

  it("releases the lease when the work fails", async () => {
    const { store, values } = memoryStore();
    const lock = createValkeyCronLock(store, { newToken: () => "token-c" });

    await expect(
      lock(env, async () => {
        throw new Error("job crashed");
      }),
    ).rejects.toThrow("job crashed");
    expect(values.has(CRON_LEASE_KEY)).toBe(false);
  });

  it("does not delete a lease that a new holder took after this one expired", async () => {
    const { store, values } = memoryStore();
    const lock = createValkeyCronLock(store, { newToken: () => "token-old" });

    await lock(env, async () => {
      // The old lease expired during a long tick and a new task took the key.
      values.set(CRON_LEASE_KEY, "token-new");
    });

    expect(values.get(CRON_LEASE_KEY)).toBe("token-new");
  });

  it("still finishes the tick when the release fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { store } = memoryStore();
    store.eval = vi.fn(async () => {
      throw new Error("valkey down");
    });

    await expect(createValkeyCronLock(store)(env, async () => {})).resolves.toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
