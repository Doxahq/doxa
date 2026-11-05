import {
  createDocsSearchIndexKey,
  docsSearchRemoteProviderSchema,
  type DocsSearchProvider,
  type DocsSearchRemoteProvider,
} from "@doxahq/contracts/docs-search";
import {
  DOCS_SEARCH_INDEX_TARGET,
  docsSearchIndexEntryKey,
  type DocsSearchIndexResource,
} from "@doxahq/contracts/storage-gc";
import { createDb, schema, type DoxaDb } from "@doxahq/db";
import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm";

import type {
  ClaimedDocsSearchTask,
  DocsSearchRecheck,
  DocsSearchTaskStore,
} from "../services/docs-search/index-worker";
import {
  DOCS_SEARCH_COLLECT_GRACE_SECONDS,
  DOCS_SEARCH_LEASE_SECONDS,
  DOCS_SEARCH_PREVIOUS_INDEX_MAX_AGE_SECONDS,
  DOCS_SEARCH_RECHECK_SECONDS,
} from "../services/docs-search/limits";
import type { DocsSearchUsageRow } from "../services/docs-search/usage-rollup";
import {
  withDocsCacheInvalidation,
  type DocsCacheDeliveryEnv,
} from "./docs-cache-mutation";
import type { DocsMutationTransaction } from "./docs-cache-invalidations";
import { docsSearchIndexTasks as tasks } from "./docs-search-index-tasks";
import { enqueueStorageCollection } from "./storage-gc";

const sites = schema.docsSites;
const versions = schema.docsVersions;

const SWEEP_LIMIT = 50;
const RECONCILE_LIMIT = 25;
const RECHECK_LIMIT = 50;
const MAX_ATTEMPTS = 6;
const RETRY_BASE_SECONDS = 60;
const RECHECK_STATUSES = ["ready", "skipped", "failed", "superseded"] as const;

type StorageWriter = Parameters<typeof enqueueStorageCollection>[0];

function readRemoteProvider(
  provider: string | null,
): DocsSearchRemoteProvider | null {
  const parsed = docsSearchRemoteProviderSchema.safeParse(provider);
  return parsed.success ? parsed.data : null;
}

/** A row's index as a collector resource, if it has one. */
function toResource(row: {
  siteId: string;
  provider: string | null;
  indexKey: string | null;
}): DocsSearchIndexResource | null {
  const provider = readRemoteProvider(row.provider);
  return provider && row.indexKey
    ? { siteId: row.siteId, provider, indexKey: row.indexKey }
    : null;
}

/** Hands an index to the collector. It waits until any writer has stopped. */
export function enqueueDocsSearchIndexCollection(
  writer: StorageWriter,
  resource: DocsSearchIndexResource,
  reason: string,
): Promise<string | null> {
  return enqueueStorageCollection(writer, {
    target: DOCS_SEARCH_INDEX_TARGET,
    resourceKey: docsSearchIndexEntryKey(resource),
    resource,
    reason,
    graceSeconds: DOCS_SEARCH_COLLECT_GRACE_SECONDS,
  });
}

/**
 * The remote indexes that the deletion of a project must remove. The locks make
 * a writer that is starting now wait, so it then finds its row gone. A retired
 * index already has its collector entry.
 */
export async function listCollectableDocsSearchIndexes(
  writer: Pick<DoxaDb, "select">,
  siteId: string,
): Promise<DocsSearchIndexResource[]> {
  await writer
    .select({ id: sites.id })
    .from(sites)
    .where(eq(sites.id, siteId))
    .for("update");
  const rows = await writer
    .select({
      siteId: tasks.siteId,
      provider: tasks.provider,
      indexKey: tasks.indexKey,
    })
    .from(tasks)
    .where(and(eq(tasks.siteId, siteId), ne(tasks.status, "retired")))
    .for("update");
  return rows.flatMap((row) => {
    const resource = toResource(row);
    return resource ? [resource] : [];
  });
}

export type DocsSearchIndexesEnv = DocsCacheDeliveryEnv;

export class DocsSearchIndexesRepository implements DocsSearchTaskStore {
  private connection?: DoxaDb;

  constructor(private readonly env: DocsSearchIndexesEnv) {}

  private get db(): DoxaDb {
    this.connection ??= createDb(this.env);
    return this.connection;
  }

  /**
   * Claims one due task of a live version. A claim starts its lease, so the
   * worker claims a task only when it can start it now.
   */
  async claimNext(
    ids?: readonly string[],
  ): Promise<ClaimedDocsSearchTask | null> {
    if (ids?.length === 0) return null;
    const claimToken = crypto.randomUUID();
    const due = this.db
      .select({ id: tasks.id })
      .from(tasks)
      .innerJoin(
        sites,
        and(
          eq(sites.id, tasks.siteId),
          eq(sites.publishedVersionId, tasks.versionId),
        ),
      )
      .where(
        and(
          ids ? inArray(tasks.id, [...ids]) : undefined,
          lt(tasks.attempts, MAX_ATTEMPTS),
          or(
            and(
              eq(tasks.status, "pending"),
              lte(tasks.nextAttemptAt, sql`now()`),
            ),
            and(
              eq(tasks.status, "running"),
              lte(tasks.leaseExpiresAt, sql`now()`),
            ),
          ),
        ),
      )
      .orderBy(asc(tasks.nextAttemptAt))
      .limit(1)
      .for("update", { of: tasks, skipLocked: true });

    await this.db
      .update(tasks)
      .set({
        status: "running",
        claimToken,
        attempts: sql`${tasks.attempts} + 1`,
        leaseExpiresAt: sql`now() + ${DOCS_SEARCH_LEASE_SECONDS} * interval '1 second'`,
        updatedAt: sql`now()`,
      })
      .where(inArray(tasks.id, due));

    const [claimed] = await this.db
      .select({
        id: tasks.id,
        siteId: tasks.siteId,
        versionId: tasks.versionId,
        projectId: sites.projectId,
        artifactPrefix: versions.artifactPrefix,
        attempts: tasks.attempts,
        claimToken: sql<string>`${tasks.claimToken}`,
      })
      .from(tasks)
      .innerJoin(sites, eq(tasks.siteId, sites.id))
      .innerJoin(versions, eq(tasks.versionId, versions.id))
      .where(eq(tasks.claimToken, claimToken))
      .limit(1);
    return claimed ?? null;
  }

  /**
   * Records the index before the write starts, so the row owns an index that may
   * exist. A retry keeps its key and finishes that index. Null means that the
   * task lost its claim or its version left production: the worker must not
   * write.
   */
  async beginWrite(
    task: ClaimedDocsSearchTask,
    provider: DocsSearchRemoteProvider,
  ): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      const [site] = await tx
        .select({ publishedVersionId: sites.publishedVersionId })
        .from(sites)
        .where(eq(sites.id, task.siteId))
        .for("update");
      if (site?.publishedVersionId !== task.versionId) return null;

      const [row] = await tx
        .select({
          siteId: tasks.siteId,
          provider: tasks.provider,
          indexKey: tasks.indexKey,
        })
        .from(tasks)
        .where(
          and(eq(tasks.id, task.id), eq(tasks.claimToken, task.claimToken)),
        )
        .for("update");
      if (!row) return null;
      if (row.provider === provider && row.indexKey) return row.indexKey;

      const replaced = toResource(row);
      if (replaced) {
        await enqueueDocsSearchIndexCollection(tx, replaced, "provider_changed");
      }
      const indexKey = createDocsSearchIndexKey(task);
      await tx
        .update(tasks)
        .set({ provider, indexKey, updatedAt: sql`now()` })
        .where(eq(tasks.id, task.id));
      return indexKey;
    });
  }

  /**
   * Records the result. The site row is locked first, as a publish does, so
   * "this version is live" stays true until the commit. Only the live version
   * changes what the site serves and retires other indexes. A version that left
   * production retires itself, so a late finisher cannot harm the live version.
   */
  async complete(
    task: ClaimedDocsSearchTask,
    outcome: {
      provider: DocsSearchProvider;
      facts: { documents: number; indexedBytes: number } | null;
    },
  ): Promise<void> {
    await withDocsCacheInvalidation(this.db, this.env, async (tx, enqueue) => {
      const [site] = await tx
        .select({
          publishedVersionId: sites.publishedVersionId,
          searchProvider: sites.searchProvider,
          searchIndexKey: sites.searchIndexKey,
          searchIndexStaleSince: sites.searchIndexStaleSince,
        })
        .from(sites)
        .where(eq(sites.id, task.siteId))
        .for("update");
      // No site: the project was deleted. Its collector entry waits for this
      // writer to end, so nothing more is necessary.
      if (!site) return;

      const [row] = await tx
        .select({
          siteId: tasks.siteId,
          provider: tasks.provider,
          indexKey: tasks.indexKey,
        })
        .from(tasks)
        .where(
          and(eq(tasks.id, task.id), eq(tasks.claimToken, task.claimToken)),
        )
        .for("update");
      if (!row) return;

      const isLive = site.publishedVersionId === task.versionId;
      const isRemote = readRemoteProvider(outcome.provider) !== null;
      const owned = toResource(row);

      // Browser search needs no index, so a version that had one gives it up.
      if (owned && !isRemote) {
        await enqueueDocsSearchIndexCollection(tx, owned, "provider_changed");
      }
      await tx
        .update(tasks)
        .set({
          status: resultStatus(isLive, isRemote),
          provider: outcome.provider,
          indexKey: isRemote ? row.indexKey : null,
          documentCount: outcome.facts?.documents ?? null,
          indexedBytes: outcome.facts?.indexedBytes ?? null,
          claimToken: null,
          leaseExpiresAt: null,
          lastError: null,
          updatedAt: sql`now()`,
        })
        .where(eq(tasks.id, task.id));

      if (!isLive) {
        if (owned && isRemote) {
          await enqueueDocsSearchIndexCollection(tx, owned, "version_replaced");
        }
        return;
      }

      const indexKey = isRemote ? row.indexKey : null;
      const targetChanged =
        site.searchProvider !== outcome.provider ||
        site.searchIndexKey !== indexKey;
      // A repair can finish with the same index while the timer runs.
      if (targetChanged || site.searchIndexStaleSince) {
        await tx
          .update(sites)
          .set({
            searchProvider: outcome.provider,
            searchIndexKey: indexKey,
            searchIndexStaleSince: null,
            updatedAt: sql`now()`,
          })
          .where(eq(sites.id, task.siteId));
      }
      if (targetChanged) await enqueue({ siteId: task.siteId });
      await closeOutdatedTasks(tx, { siteId: task.siteId });
    });
  }

  async fail(task: ClaimedDocsSearchTask, error: string): Promise<void> {
    const exhausted = task.attempts >= MAX_ATTEMPTS;
    await this.db
      .update(tasks)
      .set({
        status: exhausted ? "failed" : "pending",
        lastError: error.slice(0, 200),
        claimToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: sql`now() + ${RETRY_BASE_SECONDS * 2 ** task.attempts} * interval '1 second'`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(tasks.id, task.id), eq(tasks.claimToken, task.claimToken)));
  }

  /** Adds a task for live versions that have none, and closes old tasks. */
  async sweep(signal?: AbortSignal): Promise<void> {
    const missing = await this.db
      .select({ siteId: sites.id, versionId: sites.publishedVersionId })
      .from(sites)
      .leftJoin(
        tasks,
        and(
          eq(tasks.siteId, sites.id),
          eq(tasks.versionId, sites.publishedVersionId),
        ),
      )
      .where(and(isNull(tasks.id), isNotNull(sites.publishedVersionId)))
      .limit(RECONCILE_LIMIT);
    const values = missing.flatMap((row) =>
      row.versionId ? [{ siteId: row.siteId, versionId: row.versionId }] : [],
    );
    if (values.length > 0) {
      await this.db.insert(tasks).values(values).onConflictDoNothing();
    }

    // A worker that crashed on its last attempt can claim nothing more.
    await this.db
      .update(tasks)
      .set({
        status: "failed",
        claimToken: null,
        leaseExpiresAt: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(tasks.status, "running"),
          lte(tasks.leaseExpiresAt, sql`now()`),
          sql`${tasks.attempts} >= ${MAX_ATTEMPTS}`,
        ),
      );

    if (signal?.aborted) return;
    await this.dropExpiredTargets(signal);
    if (signal?.aborted) return;
    await this.db.transaction((tx) => closeOutdatedTasks(tx, {}));
  }

  /**
   * A site serves an older index only for a limited time, so a removed page does
   * not stay in results. The timer is on the site: a sweep starts it when it first
   * sees the site behind its live version, and a later publish or retry does not
   * restart it. A sweep also stops the timer of a site that is no longer behind,
   * whatever path brought it back. When the time ends, the site moves to browser search of the live
   * version, and a later build moves it back. The check runs again under the site
   * lock, because a build can finish between the first read and the update.
   */
  private async dropExpiredTargets(signal?: AbortSignal): Promise<void> {
    const isBehindLiveVersion = exists(
      this.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.siteId, sites.id),
            eq(tasks.versionId, sites.publishedVersionId),
            ne(tasks.status, "ready"),
            sql`${tasks.indexKey} is distinct from ${sites.searchIndexKey}`,
          ),
        ),
    );
    await this.db
      .update(sites)
      .set({ searchIndexStaleSince: null })
      .where(and(isNotNull(sites.searchIndexStaleSince), not(isBehindLiveVersion)));
    await this.db
      .update(sites)
      .set({ searchIndexStaleSince: sql`now()` })
      .where(
        and(
          isNotNull(sites.searchIndexKey),
          isNull(sites.searchIndexStaleSince),
          isBehindLiveVersion,
        ),
      );

    const hasExpired = sql<boolean>`${sites.searchIndexStaleSince} <= now() - ${DOCS_SEARCH_PREVIOUS_INDEX_MAX_AGE_SECONDS} * interval '1 second'`;
    const expired = await this.db
      .select({ siteId: sites.id })
      .from(sites)
      .where(
        and(isNotNull(sites.searchIndexKey), hasExpired, isBehindLiveVersion),
      )
      .limit(SWEEP_LIMIT);

    for (const { siteId } of expired) {
      if (signal?.aborted) return;
      await withDocsCacheInvalidation(this.db, this.env, async (tx, enqueue) => {
        const [site] = await tx
          .select({
            publishedVersionId: sites.publishedVersionId,
            searchIndexKey: sites.searchIndexKey,
            hasExpired,
          })
          .from(sites)
          .where(eq(sites.id, siteId))
          .for("update");
        if (!site?.hasExpired || !site.publishedVersionId) return;

        const [live] = await tx
          .select({ status: tasks.status, indexKey: tasks.indexKey })
          .from(tasks)
          .where(
            and(
              eq(tasks.siteId, siteId),
              eq(tasks.versionId, site.publishedVersionId),
            ),
          )
          .limit(1);
        if (
          !live ||
          live.status === "ready" ||
          live.indexKey === site.searchIndexKey
        ) {
          return;
        }

        await tx
          .update(sites)
          .set({
            searchProvider: "minisearch",
            searchIndexKey: null,
            searchIndexStaleSince: null,
            updatedAt: sql`now()`,
          })
          .where(eq(sites.id, siteId));
        await enqueue({ siteId });
      });
    }
  }

  /** Live versions that the scheduler has not compared for a while. */
  async listRechecks(): Promise<DocsSearchRecheck[]> {
    return this.db
      .select({
        id: tasks.id,
        siteId: tasks.siteId,
        versionId: tasks.versionId,
        projectId: sites.projectId,
        artifactPrefix: versions.artifactPrefix,
        status: tasks.status,
        provider: tasks.provider,
        indexKey: tasks.indexKey,
        siteProvider: sites.searchProvider,
        siteIndexKey: sites.searchIndexKey,
      })
      .from(tasks)
      .innerJoin(
        sites,
        and(
          eq(sites.id, tasks.siteId),
          eq(sites.publishedVersionId, tasks.versionId),
        ),
      )
      .innerJoin(versions, eq(tasks.versionId, versions.id))
      .where(
        and(
          inArray(tasks.status, [...RECHECK_STATUSES]),
          lte(
            tasks.updatedAt,
            sql`now() - ${DOCS_SEARCH_RECHECK_SECONDS} * interval '1 second'`,
          ),
        ),
      )
      .orderBy(asc(tasks.updatedAt))
      .limit(RECHECK_LIMIT);
  }

  /** The row goes to the back of the line, also after a check that failed. */
  async markRechecked(id: string): Promise<void> {
    await this.db
      .update(tasks)
      .set({ updatedAt: sql`now()` })
      .where(
        and(eq(tasks.id, id), inArray(tasks.status, [...RECHECK_STATUSES])),
      );
  }

  /** The plan, the setting or the index changed, so the worker runs again. */
  async reopen(id: string): Promise<void> {
    await this.db
      .update(tasks)
      .set({
        status: "pending",
        attempts: 0,
        nextAttemptAt: sql`now()`,
        lastError: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(tasks.id, id), inArray(tasks.status, [...RECHECK_STATUSES])),
      );
  }

  /** True while the site serves this index or a task still owns it. */
  async isIndexInUse(resource: DocsSearchIndexResource): Promise<boolean> {
    const [site] = await this.db
      .select({ id: sites.id })
      .from(sites)
      .where(
        and(
          eq(sites.id, resource.siteId),
          eq(sites.searchIndexKey, resource.indexKey),
        ),
      )
      .limit(1);
    if (site) return true;
    const [task] = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.siteId, resource.siteId),
          eq(tasks.indexKey, resource.indexKey),
          ne(tasks.status, "retired"),
        ),
      )
      .limit(1);
    return Boolean(task);
  }

  /** Overwrites a day: the rollup reads the whole day each time. */
  async saveUsage(rows: readonly DocsSearchUsageRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db
      .insert(schema.docsSearchUsageDaily)
      .values([...rows])
      .onConflictDoUpdate({
        target: [
          schema.docsSearchUsageDaily.day,
          schema.docsSearchUsageDaily.siteId,
          schema.docsSearchUsageDaily.provider,
          schema.docsSearchUsageDaily.outcome,
        ],
        set: {
          events: sql`excluded.events`,
          responseBytes: sql`excluded.response_bytes`,
          elapsedMsTotal: sql`excluded.elapsed_ms_total`,
          updatedAt: sql`now()`,
        },
      });
  }
}

function resultStatus(isLive: boolean, isRemote: boolean): string {
  if (isLive) return isRemote ? "ready" : "skipped";
  return isRemote ? "retired" : "superseded";
}

/**
 * Ends the tasks of versions that are no longer live. An index that the site
 * still serves stays until the live version's index is ready, so search keeps
 * working during a publish. A task that may have written goes to the collector,
 * including one that failed partway. A task that wrote nothing can reopen on a
 * restore. A running task with a valid lease ends itself in `complete`.
 */
async function closeOutdatedTasks(
  tx: DocsMutationTransaction,
  scope: { siteId?: string },
): Promise<void> {
  const rows = await tx
    .select({
      id: tasks.id,
      siteId: tasks.siteId,
      provider: tasks.provider,
      indexKey: tasks.indexKey,
    })
    .from(tasks)
    .innerJoin(sites, eq(sites.id, tasks.siteId))
    .where(
      and(
        scope.siteId ? eq(tasks.siteId, scope.siteId) : undefined,
        sql`${sites.publishedVersionId} is distinct from ${tasks.versionId}`,
        // Only a real key can be "the index that the site serves".
        or(
          isNull(tasks.indexKey),
          sql`${sites.searchIndexKey} is distinct from ${tasks.indexKey}`,
        ),
        or(
          inArray(tasks.status, ["pending", "ready", "failed"]),
          and(
            eq(tasks.status, "running"),
            lte(tasks.leaseExpiresAt, sql`now()`),
          ),
        ),
      ),
    )
    .limit(SWEEP_LIMIT)
    .for("update", { of: tasks, skipLocked: true });

  for (const row of rows) {
    const resource = toResource(row);
    await tx
      .update(tasks)
      .set({
        status: resource ? "retired" : "superseded",
        claimToken: null,
        leaseExpiresAt: null,
        updatedAt: sql`now()`,
      })
      .where(eq(tasks.id, row.id));
    if (resource) {
      await enqueueDocsSearchIndexCollection(tx, resource, "version_replaced");
    }
  }
}
