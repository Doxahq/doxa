import { schema } from "@doxahq/db";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { DocsMutationTransaction } from "./docs-cache-invalidations";

export const docsSearchIndexTasks = schema.docsSearchIndexes;
const tasks = docsSearchIndexTasks;
const sites = schema.docsSites;

/**
 * The life of a task. `index_key` is set before a remote write starts, so a row
 * with a key and any status except `retired` owns an index that may exist. Each
 * build has its own key, and no key is used twice.
 *
 * - `pending`, `running`: work to do.
 * - `ready`: the remote index exists.
 * - `skipped`: the version uses browser search.
 * - `failed`: every attempt failed. The scheduler tries again later.
 * - `superseded`: the version left production before anything was written.
 * - `retired`: the garbage collector owns its index.
 *
 * Lock order, in every transaction that needs both: the site row, then the task
 * row. A publish holds the site row first, so a worker that holds it knows which
 * version is live.
 */
const REOPENABLE_STATUSES = ["failed", "superseded", "retired"] as const;

/**
 * Opens the task of a version in the publish transaction. A retired version
 * builds a new index under a new name, and the site keeps serving its current
 * index until then. A ready or skipped version keeps its result, for example
 * after a domain change or a restore, so the site takes that result here.
 */
export async function enqueueDocsSearchIndexTask(
  tx: DocsMutationTransaction,
  input: { siteId: string; versionId: string },
): Promise<string | null> {
  await tx
    .select({ id: sites.id })
    .from(sites)
    .where(eq(sites.id, input.siteId))
    .for("update");

  const [row] = await tx
    .insert(tasks)
    .values(input)
    .onConflictDoUpdate({
      target: [tasks.siteId, tasks.versionId],
      set: {
        status: "pending",
        attempts: 0,
        nextAttemptAt: sql`now()`,
        // The collector owns a retired key. A failed build keeps its key, so a
        // retry finishes that index and leaves no partial index behind.
        provider: sql`case when ${tasks.status} = 'retired' then null else ${tasks.provider} end`,
        indexKey: sql`case when ${tasks.status} = 'retired' then null else ${tasks.indexKey} end`,
        claimToken: null,
        leaseExpiresAt: null,
        lastError: null,
        updatedAt: sql`now()`,
      },
      where: inArray(tasks.status, [...REOPENABLE_STATUSES]),
    })
    .returning({ id: tasks.id });
  if (row) return row.id;

  await applyFinishedResult(tx, input);
  return null;
}

async function applyFinishedResult(
  tx: DocsMutationTransaction,
  input: { siteId: string; versionId: string },
): Promise<void> {
  const [existing] = await tx
    .select({
      status: tasks.status,
      provider: tasks.provider,
      indexKey: tasks.indexKey,
    })
    .from(tasks)
    .where(
      and(eq(tasks.siteId, input.siteId), eq(tasks.versionId, input.versionId)),
    )
    .limit(1);
  if (!existing?.provider) return;
  if (existing.status !== "ready" && existing.status !== "skipped") return;

  await tx
    .update(sites)
    .set({
      searchProvider: existing.provider,
      searchIndexKey: existing.status === "ready" ? existing.indexKey : null,
      searchIndexStaleSince: null,
      updatedAt: sql`now()`,
    })
    .where(eq(sites.id, input.siteId));
}
