import { sql } from "drizzle-orm";
import type { DoxaDb } from "@doxahq/db";

export type DoxaTransaction = Parameters<Parameters<DoxaDb["transaction"]>[0]>[0];

/** The first key of a Postgres advisory lock. The cron lock uses 4242. */
export const SITE_LOCKS = {
  siteAssetUploads: 4_243,
  branchAssetQuota: 4_244,
} as const;

export const SITE_LOCK_BUSY = Symbol("site lock busy");

const LOCK_ATTEMPTS = 25;
const LOCK_RETRY_MS = 200;

/**
 * Runs `work` in a transaction that holds a lock of one site, so a usage
 * check and the write that it allows act as one step. A transaction lock
 * works through a transaction-mode connection pool; a session lock does not.
 *
 * A request that waits holds no connection between attempts, so requests
 * that wait for one busy site cannot use up the pool of the whole API.
 * Answers `SITE_LOCK_BUSY` after about 5 seconds.
 */
export async function runWithSiteLock<T>(
  db: DoxaDb,
  lock: (typeof SITE_LOCKS)[keyof typeof SITE_LOCKS],
  siteId: string,
  work: (tx: DoxaTransaction) => Promise<T>,
): Promise<T | typeof SITE_LOCK_BUSY> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    const outcome = await db.transaction(async (tx) => {
      const result = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(${lock}::int, hashtext(${siteId})) as locked`,
      );
      return result.rows[0]?.locked ? { value: await work(tx) } : null;
    });
    if (outcome) return outcome.value;
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
  return SITE_LOCK_BUSY;
}
