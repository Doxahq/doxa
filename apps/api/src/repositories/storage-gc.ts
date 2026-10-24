import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { createDb, schema, type DoxaDb } from "@doxahq/db";
import {
  STORAGE_GC_LIMITS,
  storageGcEntrySchema,
  storageGcReasonSchema,
  storageGcTargetSchema,
  type StorageGcEntry,
} from "@doxahq/contracts/storage-gc";

import type { Env } from "../env";
import type { DocsMutationTransaction } from "./docs-cache-invalidations";
import { oldestOpenRowAgeSeconds } from "./health-sql";

type StorageGcWriter = Pick<DoxaDb, "insert"> | DocsMutationTransaction;

export interface EnqueueStorageCollectionInput {
  target: string;
  resourceKey: string;
  resource: Record<string, unknown>;
  reason: string;
  /** Seconds to wait before the runner can delete the objects. */
  graceSeconds: number;
}

export interface StorageGcHealth {
  pendingCount: number;
  failedCount: number;
  exhaustedCount: number;
  oldestEntryAgeSeconds: number;
}

/**
 * Adds one resource to the collection work list.
 *
 * The call accepts a transaction, so a feature can record the intent in the
 * same transaction that made the resource unreferenced. A repeated call for
 * the same resource is idempotent while the entry is open. A finished entry
 * restarts, because the same resource can be written again later.
 */
export async function enqueueStorageCollection(
  writer: StorageGcWriter,
  input: EnqueueStorageCollectionInput,
): Promise<string | null> {
  const target = storageGcTargetSchema.parse(input.target);
  const reason = storageGcReasonSchema.parse(input.reason);
  const resourceKey = storageGcEntrySchema.shape.resourceKey.parse(
    input.resourceKey,
  );
  const graceSeconds = readGraceSeconds(input.graceSeconds);
  const [entry] = await writer
    .insert(schema.storageGcEntries)
    .values({
      target,
      resourceKey,
      resource: input.resource,
      reason,
      eligibleAt: sql`now() + ${graceSeconds} * interval '1 second'`,
      nextAttemptAt: sql`now() + ${graceSeconds} * interval '1 second'`,
    })
    .onConflictDoUpdate({
      target: [
        schema.storageGcEntries.target,
        schema.storageGcEntries.resourceKey,
      ],
      set: {
        resource: input.resource,
        reason,
        status: "pending",
        attemptCount: 0,
        eligibleAt: sql`now() + ${graceSeconds} * interval '1 second'`,
        nextAttemptAt: sql`now() + ${graceSeconds} * interval '1 second'`,
        claimToken: null,
        leaseDeadline: null,
        deletedObjects: 0,
        lastError: null,
        retainedReason: null,
        completedAt: null,
        updatedAt: sql`now()`,
      },
      // An open entry keeps its schedule. Only a finished entry restarts.
      setWhere: inArray(schema.storageGcEntries.status, [
        "collected",
        "retained",
      ]),
    })
    .returning({ id: schema.storageGcEntries.id });
  return entry?.id ?? null;
}

export interface StorageGcStore {
  /** Claims due entries. With `entryIds`, claims only those entries. */
  claim(entryIds?: readonly string[]): Promise<StorageGcEntry[]>;
  markCollected(input: {
    entryId: string;
    claimToken: string;
    deletedObjects: number;
  }): Promise<void>;
  markRetained(input: {
    entryId: string;
    claimToken: string;
    reason: string;
  }): Promise<void>;
  reschedule(input: {
    entryId: string;
    claimToken: string;
    deletedObjects: number;
    delaySeconds?: number;
  }): Promise<void>;
  markFailed(input: {
    entryId: string;
    claimToken: string;
    error: unknown;
  }): Promise<void>;
  prune(): Promise<number>;
  readHealth(): Promise<StorageGcHealth>;
}

export class StorageGcRepository implements StorageGcStore {
  private readonly db: DoxaDb;

  constructor(
    env: Pick<Env, "DATABASE_URL" | "HYPERDRIVE" | "HYPERDRIVE_CACHE_DISABLED">,
  ) {
    this.db = createDb(env);
  }

  async claim(entryIds?: readonly string[]): Promise<StorageGcEntry[]> {
    if (entryIds?.length === 0) return [];
    return this.db.transaction(async (tx) => {
      const candidates = await tx
        .select()
        .from(schema.storageGcEntries)
        .where(
          and(
            entryIds
              ? inArray(schema.storageGcEntries.id, [...entryIds])
              : undefined,
            sql`${schema.storageGcEntries.attemptCount} < ${STORAGE_GC_LIMITS.maxAttempts}`,
            lte(schema.storageGcEntries.eligibleAt, sql`now()`),
            or(
              and(
                inArray(schema.storageGcEntries.status, ["pending", "failed"]),
                lte(schema.storageGcEntries.nextAttemptAt, sql`now()`),
              ),
              and(
                eq(schema.storageGcEntries.status, "running"),
                lte(schema.storageGcEntries.leaseDeadline, sql`now()`),
              ),
            ),
          ),
        )
        .orderBy(
          asc(schema.storageGcEntries.nextAttemptAt),
          asc(schema.storageGcEntries.id),
        )
        .limit(STORAGE_GC_LIMITS.claimLimit)
        .for("update", { skipLocked: true });

      const claimed: StorageGcEntry[] = [];
      for (const candidate of candidates) {
        const claimToken = crypto.randomUUID();
        const [entry] = await tx
          .update(schema.storageGcEntries)
          .set({
            status: "running",
            attemptCount: sql`${schema.storageGcEntries.attemptCount} + 1`,
            claimToken,
            leaseDeadline: sql`now() + ${STORAGE_GC_LIMITS.leaseSeconds} * interval '1 second'`,
            updatedAt: sql`now()`,
          })
          .where(eq(schema.storageGcEntries.id, candidate.id))
          .returning();
        if (!entry?.claimToken) continue;
        claimed.push({
          id: entry.id,
          target: entry.target,
          resourceKey: entry.resourceKey,
          resource: entry.resource,
          reason: entry.reason,
          claimToken: entry.claimToken,
          attempt: entry.attemptCount,
        });
      }
      return claimed;
    });
  }

  async markCollected(input: {
    entryId: string;
    claimToken: string;
    deletedObjects: number;
  }): Promise<void> {
    await this.db
      .update(schema.storageGcEntries)
      .set({
        status: "collected",
        deletedObjects: sql`${schema.storageGcEntries.deletedObjects} + ${countedObjects(input.deletedObjects)}`,
        claimToken: null,
        leaseDeadline: null,
        lastError: null,
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(ownedRunningEntry(input));
  }

  async markRetained(input: {
    entryId: string;
    claimToken: string;
    reason: string;
  }): Promise<void> {
    await this.db
      .update(schema.storageGcEntries)
      .set({
        status: "retained",
        claimToken: null,
        leaseDeadline: null,
        retainedReason: sanitizeMessage(input.reason),
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(ownedRunningEntry(input));
  }

  async reschedule(input: {
    entryId: string;
    claimToken: string;
    deletedObjects: number;
    delaySeconds?: number;
  }): Promise<void> {
    const delaySeconds = readGraceSeconds(input.delaySeconds ?? 0);
    await this.db
      .update(schema.storageGcEntries)
      .set({
        status: "pending",
        attemptCount: 0,
        deletedObjects: sql`${schema.storageGcEntries.deletedObjects} + ${countedObjects(input.deletedObjects)}`,
        claimToken: null,
        leaseDeadline: null,
        nextAttemptAt: sql`now() + ${delaySeconds} * interval '1 second'`,
        updatedAt: sql`now()`,
      })
      .where(ownedRunningEntry(input));
  }

  async markFailed(input: {
    entryId: string;
    claimToken: string;
    error: unknown;
  }): Promise<void> {
    await this.db
      .update(schema.storageGcEntries)
      .set({
        status: "failed",
        claimToken: null,
        leaseDeadline: null,
        nextAttemptAt: sql`now() + ${retryDelaySeconds()} * interval '1 second'`,
        lastError: sanitizeMessage(
          input.error instanceof Error
            ? input.error.message
            : "Storage collection failed.",
        ),
        updatedAt: sql`now()`,
      })
      .where(ownedRunningEntry(input));
  }

  /** Removes finished entries. The work list is not an audit log. */
  async prune(): Promise<number> {
    const rows = await this.db
      .delete(schema.storageGcEntries)
      .where(
        and(
          inArray(schema.storageGcEntries.status, ["collected", "retained"]),
          lte(
            schema.storageGcEntries.completedAt,
            sql`now() - ${STORAGE_GC_LIMITS.historyDays} * interval '1 day'`,
          ),
        ),
      )
      .returning({ id: schema.storageGcEntries.id });
    return rows.length;
  }

  async readHealth(): Promise<StorageGcHealth> {
    const [health] = await this.db
      .select({
        pendingCount:
          sql<number>`count(*) filter (where ${schema.storageGcEntries.status} = 'pending')`.mapWith(
            Number,
          ),
        failedCount:
          sql<number>`count(*) filter (where ${schema.storageGcEntries.status} = 'failed')`.mapWith(
            Number,
          ),
        exhaustedCount:
          sql<number>`count(*) filter (where ${schema.storageGcEntries.status} = 'failed' and ${schema.storageGcEntries.attemptCount} >= ${STORAGE_GC_LIMITS.maxAttempts})`.mapWith(
            Number,
          ),
        oldestEntryAgeSeconds: oldestOpenRowAgeSeconds({
          createdAt: schema.storageGcEntries.createdAt,
          status: schema.storageGcEntries.status,
          openStatuses: ["pending", "running", "failed"],
        }).mapWith(Number),
      })
      .from(schema.storageGcEntries);
    return (
      health ?? {
        pendingCount: 0,
        failedCount: 0,
        exhaustedCount: 0,
        oldestEntryAgeSeconds: 0,
      }
    );
  }
}

function ownedRunningEntry(input: { entryId: string; claimToken: string }) {
  return and(
    eq(schema.storageGcEntries.id, input.entryId),
    eq(schema.storageGcEntries.status, "running"),
    eq(schema.storageGcEntries.claimToken, input.claimToken),
  );
}

function countedObjects(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function readGraceSeconds(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("The collection grace period is invalid.");
  }
  return value;
}

function retryDelaySeconds(): number {
  return 10 * 60;
}

function sanitizeMessage(value: string): string {
  return value
    .replace(/[ -]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, STORAGE_GC_LIMITS.maxErrorMessageLength);
}
