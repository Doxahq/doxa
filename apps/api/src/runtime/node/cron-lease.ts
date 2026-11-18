import { randomUUID } from "node:crypto";
import type { WithCronLock } from "./cron";

/** The one key of the lease. The hash tag gives it its own slot in cluster mode. */
export const CRON_LEASE_KEY = "{cron}:lock";

/**
 * How long a lease lives without a release. A tick takes seconds, so this is
 * only the bound for a task that dies while it holds the lease: the next tick
 * after it runs again.
 */
export const CRON_LEASE_TTL_MS = 10 * 60_000;

/** Deletes the key only when it still holds this holder's token. */
const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/** The two Valkey commands that the lease uses. */
export interface CronLeaseStore {
  set(key: string, value: string, px: "PX", ttlMs: number, nx: "NX"): Promise<"OK" | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

/**
 * The cron lock as a lease in Valkey: `SET key token NX PX ttl`, then a
 * compare-and-delete with the same token, so a task never removes the lease
 * of another task.
 *
 * It replaces a Postgres session advisory lock. The API reaches Postgres
 * through PgBouncer in transaction mode, where the lock and the unlock can run
 * on different server sessions. The lock then leaked, and most ticks were
 * skipped as if another task held it.
 */
export function createValkeyCronLock(
  store: CronLeaseStore,
  options: { ttlMs?: number; newToken?: () => string } = {},
): WithCronLock {
  const ttlMs = options.ttlMs ?? CRON_LEASE_TTL_MS;
  const newToken = options.newToken ?? randomUUID;

  return async (_env, work) => {
    const token = newToken();
    const taken = await store.set(CRON_LEASE_KEY, token, "PX", ttlMs, "NX");
    if (taken !== "OK") return false;
    try {
      await work();
      return true;
    } finally {
      await store.eval(RELEASE_SCRIPT, 1, CRON_LEASE_KEY, token).catch((cause: unknown) => {
        // The lease then ends at its TTL, and the next tick after that runs.
        console.warn("The cron lease was not released.", cause instanceof Error ? cause.message : cause);
      });
    }
  };
}
