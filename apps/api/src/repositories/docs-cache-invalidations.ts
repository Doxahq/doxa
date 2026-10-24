import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { schema, type DoxaDb } from "@doxahq/db";
import type { DocsCacheInvalidation } from "@doxahq/contracts";

export type DocsMutationTransaction = Parameters<
  Parameters<DoxaDb["transaction"]>[0]
>[0];

export interface ClaimedDocsCacheInvalidation {
  id: string;
  siteId: string;
  hostname: string | null;
  attempts: number;
  claimToken: string;
}

export interface DocsCacheInvalidationStore {
  claim(ids?: string[]): Promise<ClaimedDocsCacheInvalidation[]>;
  complete(task: ClaimedDocsCacheInvalidation): Promise<void>;
  fail(
    task: ClaimedDocsCacheInvalidation,
    error: string,
    delaySeconds: number,
  ): Promise<void>;
}

export interface DocsCacheInvalidationHealth {
  pendingCount: number;
  delayedCount: number;
  failedCount: number;
  oldestPendingAgeSeconds: number;
  maxAttempts: number;
}

export interface DocsCacheInvalidationHealthStore {
  readHealth(): Promise<DocsCacheInvalidationHealth>;
}

export async function enqueueDocsCacheInvalidation(
  tx: DocsMutationTransaction,
  input: DocsCacheInvalidation,
): Promise<string> {
  const id = crypto.randomUUID();
  await tx.insert(schema.docsCacheInvalidations).values({ id, ...input });
  return id;
}

const tasks = schema.docsCacheInvalidations;
const CLAIM_LIMIT = 25;
// Longer than a full batch of 25 three-second purge attempts.
const LEASE_SECONDS = 120;

export class DocsCacheInvalidationsRepository
  implements DocsCacheInvalidationStore, DocsCacheInvalidationHealthStore
{
  constructor(private readonly db: DoxaDb) {}

  async claim(ids?: string[]): Promise<ClaimedDocsCacheInvalidation[]> {
    if (ids?.length === 0) return [];
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            isNull(tasks.completedAt),
            lte(tasks.nextAttemptAt, sql`now()`),
            or(isNull(tasks.leaseUntil), lte(tasks.leaseUntil, sql`now()`)),
            ids ? inArray(tasks.id, ids) : undefined,
          ),
        )
        .orderBy(asc(tasks.nextAttemptAt), asc(tasks.id))
        .limit(CLAIM_LIMIT)
        .for("update", { skipLocked: true });
      if (due.length === 0) return [];
      const claimToken = crypto.randomUUID();
      const claimed = await tx
        .update(tasks)
        .set({
          claimToken,
          leaseUntil: sql`now() + ${LEASE_SECONDS} * interval '1 second'`,
          attempts: sql`${tasks.attempts} + 1`,
        })
        .where(
          inArray(
            tasks.id,
            due.map(({ id }) => id),
          ),
        )
        .returning();
      return claimed.map((task) => ({ ...task, claimToken }));
    });
  }

  async complete(task: ClaimedDocsCacheInvalidation): Promise<void> {
    await this.db
      .update(tasks)
      .set({
        completedAt: sql`now()`,
        claimToken: null,
        leaseUntil: null,
        lastError: null,
      })
      .where(ownedClaim(task));
  }

  async fail(
    task: ClaimedDocsCacheInvalidation,
    error: string,
    delaySeconds: number,
  ): Promise<void> {
    await this.db
      .update(tasks)
      .set({
        nextAttemptAt: sql`now() + ${delaySeconds} * interval '1 second'`,
        claimToken: null,
        leaseUntil: null,
        lastError: error,
      })
      .where(ownedClaim(task));
  }

  async readHealth(): Promise<DocsCacheInvalidationHealth> {
    const [health] = await this.db
      .select({
        pendingCount: sql<number>`count(*)`.mapWith(Number),
        delayedCount:
          sql<number>`count(*) filter (where ${tasks.nextAttemptAt} <= now() and (${tasks.leaseUntil} is null or ${tasks.leaseUntil} <= now()))`.mapWith(
            Number,
          ),
        failedCount:
          sql<number>`count(*) filter (where ${tasks.lastError} is not null)`.mapWith(
            Number,
          ),
        oldestPendingAgeSeconds:
          sql<number>`coalesce(extract(epoch from now() - min(${tasks.createdAt})), 0)`.mapWith(
            Number,
          ),
        maxAttempts: sql<number>`coalesce(max(${tasks.attempts}), 0)`.mapWith(
          Number,
        ),
      })
      .from(tasks)
      .where(isNull(tasks.completedAt));

    return health ?? emptyHealth();
  }
}

function emptyHealth(): DocsCacheInvalidationHealth {
  return {
    pendingCount: 0,
    delayedCount: 0,
    failedCount: 0,
    oldestPendingAgeSeconds: 0,
    maxAttempts: 0,
  };
}

function ownedClaim(task: ClaimedDocsCacheInvalidation) {
  return and(
    eq(tasks.id, task.id),
    eq(tasks.claimToken, task.claimToken),
    isNull(tasks.completedAt),
  );
}
