import {
  and,
  asc,
  eq,
  gt,
  inArray,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { createDb, schema, type DoxaDb } from "@doxahq/db";
import type { DocsAccessPolicy, DocsHostResolution } from "@doxahq/contracts";
import {
  createPrerenderIdentity,
  normalizePublicDocsPathname,
  prerenderIdentitySchema,
  type PrerenderIdentity,
} from "@doxahq/contracts/docs-prerender";
import {
  DOCS_PRERENDER_MAX_ATTEMPTS,
  prerenderRepairRequestSchema,
  type DocsPrerenderTaskReason,
  type PrerenderRepairRequest,
  type PrerenderTaskApiRpc,
  type PrerenderTaskEligibilityResult,
  type PrerenderTaskFenceResult,
  type PrerenderTaskPayload,
} from "@doxahq/contracts/docs-prerender-tasks";

import {
  DOCS_PRERENDER_RENDER_TARGET,
  createDocsPrerenderRenderKey,
} from "@doxahq/contracts/storage-gc";

import { isDocsPreviewGateEnabled, type Env } from "../env";
import { resolveProductionDocsAccessPolicy } from "../services/docs-access";
import { createGeneratedDocsHostname } from "../utils/docs-url";
import type { DocsMutationTransaction } from "./docs-cache-invalidations";
import { oldestOpenRowAgeSeconds } from "./health-sql";
import { enqueueStorageCollection } from "./storage-gc";

/**
 * Wait time before the garbage collector may delete an obsolete render.
 *
 * The dispatcher can hold a resolved hostname for one hour, so a request can
 * still ask for a render that just became obsolete. One day keeps a wide
 * margin and still bounds storage growth.
 */
const RENDER_COLLECTION_GRACE_SECONDS = 24 * 60 * 60;
const CLAIM_LIMIT = 10;
const CLAIM_CANDIDATE_LIMIT = 50;
const MAX_RUNNING_PER_SITE = 2;
const LEASE_SECONDS = 20 * 60;
const REPAIR_COOLDOWN_SECONDS = 60;
const RECONCILE_LIMIT = 25;
const MANIFEST_RECONCILE_LIMIT = 10;
const MANIFEST_RECHECK_SECONDS = 5 * 60;
const MAX_ERROR_MESSAGE_LENGTH = 500;

type TaskRow = typeof schema.docsPrerenderTasks.$inferSelect;

export interface DocsPrerenderTaskConfig {
  docsBaseDomain: string;
  rendererReleaseId: string;
  accessPolicy: DocsAccessPolicy;
}

export interface EnqueuePublicationTasksInput {
  siteId: string;
  publishedVersionId: string;
  reason: Exclude<DocsPrerenderTaskReason, "repair" | "reconciliation">;
  hostname?: string;
}

interface PrerenderTaskContext {
  siteId: string;
  projectId: string;
  projectSlug: string;
  publishedVersionId: string;
  artifactPrefix: string;
  manifestPath: string;
  hostname: string;
}

interface ClaimedTaskContext extends TaskRow {
  projectId: string;
  projectSlug: string;
}

export interface PrerenderManifestCandidate {
  taskId: string;
  identity: PrerenderIdentity;
}

export interface CollectableRender {
  siteId: string;
  renderId: string;
  hostname: string;
}

/**
 * Records the stored objects of one render as collectable. The collector
 * checks the render against live production data before it deletes them.
 */
export function enqueueDocsPrerenderRenderCollection(
  writer: Parameters<typeof enqueueStorageCollection>[0],
  render: CollectableRender,
  reason: string,
): Promise<string | null> {
  return enqueueStorageCollection(writer, {
    target: DOCS_PRERENDER_RENDER_TARGET,
    resourceKey: createDocsPrerenderRenderKey(render),
    resource: {
      siteId: render.siteId,
      renderId: render.renderId,
      hostname: render.hostname,
    },
    reason,
    graceSeconds: RENDER_COLLECTION_GRACE_SECONDS,
  });
}

export const collectableRenderColumns = {
  siteId: schema.docsPrerenderTasks.siteId,
  renderId: schema.docsPrerenderTasks.renderId,
  hostname: schema.docsPrerenderTasks.hostname,
} as const;

export function readDocsPrerenderTaskConfig(
  env: Pick<
    Env,
    | "DOCS_BASE_DOMAIN"
    | "DOXA_RENDERER_RELEASE_ID"
    | "DOCS_PREVIEW_GATE_ENABLED"
  >,
): DocsPrerenderTaskConfig | null {
  const docsBaseDomain = env.DOCS_BASE_DOMAIN?.trim().toLowerCase();
  const rendererReleaseId = env.DOXA_RENDERER_RELEASE_ID?.trim();
  if (
    !docsBaseDomain ||
    !rendererReleaseId ||
    !/^[a-f0-9]{64}$/.test(rendererReleaseId)
  ) {
    return null;
  }
  // Saved output is public by definition. If production ever becomes gated,
  // this subsystem stops instead of storing gated pages in a shared bucket.
  const accessPolicy = resolveProductionDocsAccessPolicy({
    gateEnabled: isDocsPreviewGateEnabled(env.DOCS_PREVIEW_GATE_ENABLED),
  });
  if (accessPolicy !== "public") return null;
  return { docsBaseDomain, rendererReleaseId, accessPolicy };
}

export function createObsoletePrerenderTaskCondition(
  config: DocsPrerenderTaskConfig,
) {
  // A succeeded task is included. Its stored render stops serving production
  // as soon as the publication, the hostname, or the release changes, and the
  // garbage collector needs that transition to find the objects.
  return and(
    inArray(schema.docsPrerenderTasks.status, [
      "pending",
      "running",
      "failed",
      "succeeded",
    ]),
    or(
      ne(
        schema.docsPrerenderTasks.rendererReleaseId,
        config.rendererReleaseId,
      ),
      sql`not exists (
        select 1 from ${schema.docsSites}
        where ${schema.docsSites.id} = ${schema.docsPrerenderTasks.siteId}
          and ${schema.docsSites.publishedVersionId} = ${schema.docsPrerenderTasks.publishedVersionId}
          and (
            ${schema.docsPrerenderTasks.hostname} = (${schema.docsSites.slug} || '.' || ${config.docsBaseDomain})
            or exists (
              select 1 from ${schema.docsDomains}
              where ${schema.docsDomains.siteId} = ${schema.docsSites.id}
                and ${schema.docsDomains.hostname} = ${schema.docsPrerenderTasks.hostname}
                and ${schema.docsDomains.kind} = 'custom_domain'
                and ${schema.docsDomains.status} = 'active'
                and ${schema.docsDomains.verificationStatus} = 'verified'
            )
          )
      )`,
    ),
  )!;
}

export async function enqueuePublicationPrerenderTasks(
  tx: DocsMutationTransaction,
  config: DocsPrerenderTaskConfig | null,
  input: EnqueuePublicationTasksInput,
): Promise<string[]> {
  if (!config) return [];
  const [published] = await tx
    .select({
      siteId: schema.docsSites.id,
      projectId: schema.docsSites.projectId,
      projectSlug: schema.docsSites.slug,
      publishedVersionId: schema.docsVersions.id,
      artifactPrefix: schema.docsVersions.artifactPrefix,
      manifestPath: schema.docsVersions.manifestPath,
    })
    .from(schema.docsSites)
    .innerJoin(
      schema.docsVersions,
      and(
        eq(schema.docsSites.publishedVersionId, schema.docsVersions.id),
        eq(schema.docsVersions.siteId, schema.docsSites.id),
      ),
    )
    .where(
      and(
        eq(schema.docsSites.id, input.siteId),
        eq(schema.docsVersions.id, input.publishedVersionId),
      ),
    )
    .limit(1);
  if (!published) return [];

  const hostnames = input.hostname
    ? [input.hostname]
    : await listActiveProductionHostnames(
        tx,
        published,
        config.docsBaseDomain,
      );
  const taskIds: string[] = [];
  for (const hostname of hostnames) {
    const taskId = await insertTask(
      tx,
      { ...published, hostname },
      config.rendererReleaseId,
      input.reason,
    );
    if (taskId) taskIds.push(taskId);
  }
  return taskIds;
}

export class DocsPrerenderTasksRepository implements PrerenderTaskApiRpc {
  private readonly db: DoxaDb;
  private readonly config: DocsPrerenderTaskConfig | null;

  constructor(env: Pick<
    Env,
    | "DATABASE_URL"
    | "HYPERDRIVE"
    | "HYPERDRIVE_CACHE_DISABLED"
    | "DOCS_BASE_DOMAIN"
    | "DOXA_RENDERER_RELEASE_ID"
    | "DOCS_PREVIEW_GATE_ENABLED"
  >) {
    this.db = createDb(env);
    this.config = readDocsPrerenderTaskConfig(env);
  }

  async claim(ids?: string[]): Promise<PrerenderTaskPayload[]> {
    const config = this.config;
    if (!config || ids?.length === 0) return [];
    return this.db.transaction(async (tx) => {
      const running = await tx
        .select({
          siteId: schema.docsPrerenderTasks.siteId,
          count: sql<number>`count(*)`.mapWith(Number),
        })
        .from(schema.docsPrerenderTasks)
        .where(
          and(
            eq(schema.docsPrerenderTasks.status, "running"),
            gt(schema.docsPrerenderTasks.leaseDeadline, sql`now()`),
          ),
        )
        .groupBy(schema.docsPrerenderTasks.siteId);
      const runningBySite = new Map(
        running.map((row) => [row.siteId, row.count]),
      );
      const candidates = await tx
        .select({
          task: schema.docsPrerenderTasks,
          projectId: schema.docsSites.projectId,
          projectSlug: schema.docsSites.slug,
        })
        .from(schema.docsPrerenderTasks)
        .innerJoin(
          schema.docsSites,
          eq(schema.docsPrerenderTasks.siteId, schema.docsSites.id),
        )
        .where(
          and(
            ids ? inArray(schema.docsPrerenderTasks.id, ids) : undefined,
            sql`${schema.docsPrerenderTasks.attemptCount} < ${DOCS_PRERENDER_MAX_ATTEMPTS}`,
            or(
              and(
                inArray(schema.docsPrerenderTasks.status, [
                  "pending",
                  "failed",
                ]),
                lte(schema.docsPrerenderTasks.nextAttemptAt, sql`now()`),
              ),
              and(
                eq(schema.docsPrerenderTasks.status, "running"),
                lte(schema.docsPrerenderTasks.leaseDeadline, sql`now()`),
              ),
            ),
          ),
        )
        .orderBy(
          asc(schema.docsPrerenderTasks.nextAttemptAt),
          asc(schema.docsPrerenderTasks.id),
        )
        .limit(CLAIM_CANDIDATE_LIMIT)
        .for("update", { skipLocked: true });

      const selected = candidates.filter(({ task }) => {
        const count = runningBySite.get(task.siteId) ?? 0;
        if (count >= MAX_RUNNING_PER_SITE) return false;
        runningBySite.set(task.siteId, count + 1);
        return true;
      }).slice(0, CLAIM_LIMIT);

      const claimed: PrerenderTaskPayload[] = [];
      for (const candidate of selected) {
        const claimToken = crypto.randomUUID();
        const [task] = await tx
          .update(schema.docsPrerenderTasks)
          .set({
            status: "running",
            attemptCount: sql`${schema.docsPrerenderTasks.attemptCount} + 1`,
            claimToken,
            leaseDeadline: sql`now() + ${LEASE_SECONDS} * interval '1 second'`,
            heartbeatAt: sql`now()`,
            completedAt: null,
            updatedAt: sql`now()`,
          })
          .where(eq(schema.docsPrerenderTasks.id, candidate.task.id))
          .returning();
        if (task) {
          claimed.push(
            toTaskPayload(
              {
                ...task,
                projectId: candidate.projectId,
                projectSlug: candidate.projectSlug,
              },
              config.accessPolicy,
            ),
          );
        }
      }
      return claimed;
    });
  }

  async validate(input: {
    taskId: string;
    claimToken: string;
    identity: PrerenderIdentity;
  }): Promise<PrerenderTaskEligibilityResult> {
    const identity = prerenderIdentitySchema.parse(input.identity);
    const context = await this.getClaimedContext(input);
    if (!context) return { status: "stale" };
    if (!(await this.isCurrent(context, identity))) {
      await this.markObsolete(input.taskId, input.claimToken);
      return { status: "obsolete" };
    }
    return { status: "active" };
  }

  async heartbeat(input: {
    taskId: string;
    claimToken: string;
    completedRoutes: number;
    totalRoutes: number;
  }): Promise<PrerenderTaskFenceResult> {
    if (
      !Number.isInteger(input.completedRoutes) ||
      !Number.isInteger(input.totalRoutes) ||
      input.completedRoutes < 0 ||
      input.totalRoutes < input.completedRoutes
    ) {
      return { status: "stale" };
    }
    const rows = await this.db
      .update(schema.docsPrerenderTasks)
      .set({
        completedRoutes: input.completedRoutes,
        totalRoutes: input.totalRoutes,
        heartbeatAt: sql`now()`,
        leaseDeadline: sql`now() + ${LEASE_SECONDS} * interval '1 second'`,
        updatedAt: sql`now()`,
      })
      .where(ownedRunningClaim(input))
      .returning({ id: schema.docsPrerenderTasks.id });
    return fenceResult(rows);
  }

  async complete(input: {
    taskId: string;
    claimToken: string;
    routeCount: number;
    outcome: "committed" | "already_complete";
  }): Promise<PrerenderTaskFenceResult> {
    if (!Number.isInteger(input.routeCount) || input.routeCount < 0) {
      return { status: "stale" };
    }
    const rows = await this.db
      .update(schema.docsPrerenderTasks)
      .set({
        status: "succeeded",
        completedRoutes: input.routeCount,
        totalRoutes: input.routeCount,
        claimToken: null,
        leaseDeadline: null,
        heartbeatAt: sql`now()`,
        lastErrorCode: null,
        lastErrorMessage: null,
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(ownedRunningClaim(input))
      .returning({ id: schema.docsPrerenderTasks.id });
    return fenceResult(rows);
  }

  async fail(input: {
    taskId: string;
    claimToken: string;
    errorCode: "prerender_failed" | "unsupported_output";
    errorMessage: string;
    retryable: boolean;
  }): Promise<PrerenderTaskFenceResult> {
    const [task] = await this.db
      .select({ attemptCount: schema.docsPrerenderTasks.attemptCount })
      .from(schema.docsPrerenderTasks)
      .where(ownedRunningClaim(input))
      .limit(1);
    if (!task) return { status: "stale" };
    const exhausted = task.attemptCount >= DOCS_PRERENDER_MAX_ATTEMPTS;
    const retryable = input.retryable && !exhausted;
    const rows = await this.db
      .update(schema.docsPrerenderTasks)
      .set({
        status: "failed",
        nextAttemptAt: retryable
          ? sql`now() + ${retryDelaySeconds(task.attemptCount)} * interval '1 second'`
          : sql`now()`,
        claimToken: null,
        leaseDeadline: null,
        lastErrorCode: input.errorCode,
        lastErrorMessage: sanitizeError(input.errorMessage),
        completedAt: retryable ? null : sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(ownedRunningClaim(input))
      .returning({ id: schema.docsPrerenderTasks.id });
    return fenceResult(rows);
  }

  async failDispatch(
    task: PrerenderTaskPayload,
    error: unknown,
  ): Promise<PrerenderTaskFenceResult> {
    return this.fail({
      taskId: task.taskId,
      claimToken: task.claimToken,
      errorCode: "prerender_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      retryable: true,
    });
  }

  async enqueueRepair(input: PrerenderRepairRequest): Promise<{
    status: "accepted" | "cooldown";
    taskId?: string;
  }> {
    const config = this.config;
    if (!config) return { status: "cooldown" };
    const repair = prerenderRepairRequestSchema.parse(input);
    normalizePublicDocsPathname(repair.pathname);
    if (
      repair.identity.rendererReleaseId !== config.rendererReleaseId ||
      !(await this.isRepairIdentityCurrent(repair))
    ) {
      return { status: "cooldown" };
    }
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.docsPrerenderTasks)
        .where(eq(schema.docsPrerenderTasks.renderId, repair.identity.renderId))
        .for("update")
        .limit(1);
      if (existing) {
        const cooldownBoundary = new Date(
          Date.now() - REPAIR_COOLDOWN_SECONDS * 1_000,
        );
        if (
          existing.status === "pending" ||
          existing.status === "running" ||
          existing.updatedAt > cooldownBoundary
        ) {
          return { status: "cooldown" };
        }
        const [reopened] = await tx
          .update(schema.docsPrerenderTasks)
          .set({
            reason: "repair",
            status: "pending",
            attemptCount: 0,
            nextAttemptAt: sql`now()`,
            claimToken: null,
            leaseDeadline: null,
            heartbeatAt: null,
            completedRoutes: 0,
            totalRoutes: 0,
            lastErrorCode: null,
            lastErrorMessage: null,
            completedAt: null,
            updatedAt: sql`now()`,
          })
          .where(eq(schema.docsPrerenderTasks.id, existing.id))
          .returning({ id: schema.docsPrerenderTasks.id });
        return reopened
          ? { status: "accepted", taskId: reopened.id }
          : { status: "cooldown" };
      }
      const context = await this.readCurrentContext(
        repair.resolution.siteId,
        repair.identity.trustedRequestOrigin,
      );
      if (!context) return { status: "cooldown" };
      const taskId = await insertTask(
        tx,
        context,
        config.rendererReleaseId,
        "repair",
      );
      return taskId
        ? { status: "accepted", taskId }
        : { status: "cooldown" };
    });
  }

  async reconcile(): Promise<{ created: number; obsoleted: number }> {
    if (!this.config) return { created: 0, obsoleted: 0 };
    const obsoleted = await this.obsoleteChangedPublications();
    const contexts = await this.listMissingCurrentContexts();
    let created = 0;
    for (const context of contexts) {
      const taskId = await insertTask(
        this.db,
        context,
        this.config.rendererReleaseId,
        "reconciliation",
      );
      if (taskId) created += 1;
    }
    return { created, obsoleted };
  }

  async listManifestCandidates(): Promise<PrerenderManifestCandidate[]> {
    if (!this.config) return [];
    const tasks = await this.db
      .select({ task: schema.docsPrerenderTasks })
      .from(schema.docsPrerenderTasks)
      .where(
        and(
          eq(schema.docsPrerenderTasks.status, "succeeded"),
          eq(
            schema.docsPrerenderTasks.rendererReleaseId,
            this.config.rendererReleaseId,
          ),
          lte(
            schema.docsPrerenderTasks.updatedAt,
            sql`now() - ${MANIFEST_RECHECK_SECONDS} * interval '1 second'`,
          ),
        ),
      )
      .orderBy(asc(schema.docsPrerenderTasks.updatedAt))
      .limit(MANIFEST_RECONCILE_LIMIT);
    return tasks.map(({ task }) => ({
      taskId: task.id,
      identity: toStoredIdentity(task),
    }));
  }

  async markManifestVerified(
    candidate: PrerenderManifestCandidate,
  ): Promise<void> {
    await this.db
      .update(schema.docsPrerenderTasks)
      .set({ updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.docsPrerenderTasks.id, candidate.taskId),
          eq(schema.docsPrerenderTasks.status, "succeeded"),
          eq(
            schema.docsPrerenderTasks.renderId,
            candidate.identity.renderId,
          ),
        ),
      );
  }

  async reopenMissingOutput(
    candidate: PrerenderManifestCandidate,
  ): Promise<"reopened" | "stale"> {
    const [row] = await this.db
      .select({
        task: schema.docsPrerenderTasks,
        projectId: schema.docsSites.projectId,
        projectSlug: schema.docsSites.slug,
      })
      .from(schema.docsPrerenderTasks)
      .innerJoin(
        schema.docsSites,
        eq(schema.docsPrerenderTasks.siteId, schema.docsSites.id),
      )
      .where(
        and(
          eq(schema.docsPrerenderTasks.id, candidate.taskId),
          eq(schema.docsPrerenderTasks.status, "succeeded"),
          eq(
            schema.docsPrerenderTasks.renderId,
            candidate.identity.renderId,
          ),
        ),
      )
      .limit(1);
    if (!row) return "stale";
    const task = {
      ...row.task,
      projectId: row.projectId,
      projectSlug: row.projectSlug,
    };
    if (!(await this.isCurrent(task, candidate.identity))) {
      const rows = await this.db
        .update(schema.docsPrerenderTasks)
        .set({
          status: "obsolete",
          completedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(schema.docsPrerenderTasks.id, candidate.taskId),
            eq(schema.docsPrerenderTasks.status, "succeeded"),
          ),
        )
        .returning(collectableRenderColumns);
      await this.enqueueRenderCollection(rows, "publication_changed");
      return "stale";
    }
    const rows = await this.db
      .update(schema.docsPrerenderTasks)
      .set({
        reason: "reconciliation",
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: sql`now()`,
        claimToken: null,
        leaseDeadline: null,
        heartbeatAt: null,
        completedRoutes: 0,
        totalRoutes: 0,
        lastErrorCode: null,
        lastErrorMessage: null,
        completedAt: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(schema.docsPrerenderTasks.id, candidate.taskId),
          eq(schema.docsPrerenderTasks.status, "succeeded"),
          eq(
            schema.docsPrerenderTasks.renderId,
            candidate.identity.renderId,
          ),
        ),
      )
      .returning({ id: schema.docsPrerenderTasks.id });
    return rows.length > 0 ? "reopened" : "stale";
  }

  async readHealth(): Promise<{
    pendingCount: number;
    runningCount: number;
    failedCount: number;
    exhaustedCount: number;
    oldestTaskAgeSeconds: number;
  }> {
    const [health] = await this.db
      .select({
        pendingCount:
          sql<number>`count(*) filter (where ${schema.docsPrerenderTasks.status} = 'pending')`.mapWith(
            Number,
          ),
        runningCount:
          sql<number>`count(*) filter (where ${schema.docsPrerenderTasks.status} = 'running')`.mapWith(
            Number,
          ),
        failedCount:
          sql<number>`count(*) filter (where ${schema.docsPrerenderTasks.status} = 'failed')`.mapWith(
            Number,
          ),
        exhaustedCount:
          sql<number>`count(*) filter (where ${schema.docsPrerenderTasks.status} = 'failed' and ${schema.docsPrerenderTasks.attemptCount} >= ${DOCS_PRERENDER_MAX_ATTEMPTS})`.mapWith(
            Number,
          ),
        oldestTaskAgeSeconds: oldestOpenRowAgeSeconds({
          createdAt: schema.docsPrerenderTasks.createdAt,
          status: schema.docsPrerenderTasks.status,
          openStatuses: ["pending", "running", "failed"],
        }).mapWith(Number),
      })
      .from(schema.docsPrerenderTasks);
    return (
      health ?? {
        pendingCount: 0,
        runningCount: 0,
        failedCount: 0,
        exhaustedCount: 0,
        oldestTaskAgeSeconds: 0,
      }
    );
  }

  private async getClaimedContext(input: {
    taskId: string;
    claimToken: string;
  }): Promise<ClaimedTaskContext | null> {
    const [row] = await this.db
      .select({
        task: schema.docsPrerenderTasks,
        projectId: schema.docsSites.projectId,
        projectSlug: schema.docsSites.slug,
      })
      .from(schema.docsPrerenderTasks)
      .innerJoin(
        schema.docsSites,
        eq(schema.docsPrerenderTasks.siteId, schema.docsSites.id),
      )
      .where(ownedRunningClaim(input))
      .limit(1);
    return row
      ? {
          ...row.task,
          projectId: row.projectId,
          projectSlug: row.projectSlug,
        }
      : null;
  }

  private async isCurrent(
    task: ClaimedTaskContext,
    identity: PrerenderIdentity,
  ): Promise<boolean> {
    if (!this.config || !sameStoredIdentity(task, identity)) return false;
    const context = await this.readCurrentContext(
      task.siteId,
      task.trustedRequestOrigin,
    );
    return Boolean(
      context &&
        context.publishedVersionId === task.publishedVersionId &&
        context.artifactPrefix === task.artifactPrefix &&
        context.manifestPath === task.sourceManifestPath,
    );
  }

  private async isRepairIdentityCurrent(
    repair: PrerenderRepairRequest,
  ): Promise<boolean> {
    const context = await this.readCurrentContext(
      repair.resolution.siteId,
      repair.identity.trustedRequestOrigin,
    );
    if (!context || !this.config) return false;
    const expected = await createTaskIdentity(
      context,
      this.config.rendererReleaseId,
    );
    return (
      context.projectId === repair.resolution.projectId &&
      context.projectSlug === repair.resolution.projectSlug &&
      context.publishedVersionId === repair.resolution.publishedVersionId &&
      context.artifactPrefix === repair.resolution.artifactPrefix &&
      context.manifestPath === repair.resolution.manifestPath &&
      expected.renderId === repair.identity.renderId
    );
  }

  private async readCurrentContext(
    siteId: string,
    trustedRequestOrigin: string,
  ): Promise<PrerenderTaskContext | null> {
    let hostname: string;
    try {
      const origin = new URL(trustedRequestOrigin);
      if (origin.protocol !== "https:" || origin.origin !== trustedRequestOrigin) {
        return null;
      }
      hostname = origin.hostname;
    } catch {
      return null;
    }
    const [published] = await this.db
      .select({
        siteId: schema.docsSites.id,
        projectId: schema.docsSites.projectId,
        projectSlug: schema.docsSites.slug,
        publishedVersionId: schema.docsVersions.id,
        artifactPrefix: schema.docsVersions.artifactPrefix,
        manifestPath: schema.docsVersions.manifestPath,
      })
      .from(schema.docsSites)
      .innerJoin(
        schema.docsVersions,
        and(
          eq(schema.docsSites.publishedVersionId, schema.docsVersions.id),
          eq(schema.docsVersions.siteId, schema.docsSites.id),
        ),
      )
      .where(eq(schema.docsSites.id, siteId))
      .limit(1);
    if (!published || !this.config) return null;
    const generated = createGeneratedDocsHostname(
      published.projectSlug,
      this.config.docsBaseDomain,
    );
    if (hostname !== generated) {
      const [domain] = await this.db
        .select({ id: schema.docsDomains.id })
        .from(schema.docsDomains)
        .where(
          and(
            eq(schema.docsDomains.siteId, siteId),
            eq(schema.docsDomains.hostname, hostname),
            eq(schema.docsDomains.kind, "custom_domain"),
            eq(schema.docsDomains.status, "active"),
            eq(schema.docsDomains.verificationStatus, "verified"),
          ),
        )
        .limit(1);
      if (!domain) return null;
    }
    return { ...published, hostname };
  }

  private async markObsolete(
    taskId: string,
    claimToken: string,
  ): Promise<void> {
    const rows = await this.db
      .update(schema.docsPrerenderTasks)
      .set({
        status: "obsolete",
        claimToken: null,
        leaseDeadline: null,
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(ownedRunningClaim({ taskId, claimToken }))
      .returning(collectableRenderColumns);
    await this.enqueueRenderCollection(rows, "task_obsolete");
  }

  private async obsoleteChangedPublications(): Promise<number> {
    const config = this.config;
    if (!config) return 0;
    const rows = await this.db
      .update(schema.docsPrerenderTasks)
      .set({
        status: "obsolete",
        claimToken: null,
        leaseDeadline: null,
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(createObsoletePrerenderTaskCondition(config))
      .returning(collectableRenderColumns);
    await this.enqueueRenderCollection(rows, "publication_changed");
    return rows.length;
  }

  /**
   * Records the stored objects of an obsolete render as collectable.
   *
   * The entry only starts the grace period. The collector checks the render
   * against live production data again before it deletes an object.
   */
  private async enqueueRenderCollection(
    renders: readonly CollectableRender[],
    reason: string,
  ): Promise<void> {
    for (const render of renders) {
      try {
        await enqueueDocsPrerenderRenderCollection(this.db, render, reason);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "docs_prerender_collection_enqueue_failed",
            siteId: render.siteId,
            renderId: render.renderId,
            reason,
            errorClass: error instanceof Error ? error.name : "UnknownError",
          }),
        );
      }
    }
  }

  /**
   * Reports whether one render still serves a production hostname.
   *
   * The garbage collector calls this before deletion. The answer uses the
   * current published version, the current renderer release, and the active
   * hostnames of the site.
   */
  async isRenderCurrent(input: {
    siteId: string;
    renderId: string;
  }): Promise<boolean> {
    const config = this.config;
    if (!config) return false;
    const [published] = await this.db
      .select({
        siteId: schema.docsSites.id,
        projectId: schema.docsSites.projectId,
        projectSlug: schema.docsSites.slug,
        publishedVersionId: schema.docsVersions.id,
        artifactPrefix: schema.docsVersions.artifactPrefix,
        manifestPath: schema.docsVersions.manifestPath,
      })
      .from(schema.docsSites)
      .innerJoin(
        schema.docsVersions,
        and(
          eq(schema.docsSites.publishedVersionId, schema.docsVersions.id),
          eq(schema.docsVersions.siteId, schema.docsSites.id),
        ),
      )
      .where(eq(schema.docsSites.id, input.siteId))
      .limit(1);
    if (!published) return false;

    const hostnames = await listActiveProductionHostnames(
      this.db,
      published,
      config.docsBaseDomain,
    );
    for (const hostname of hostnames) {
      const identity = await createTaskIdentity(
        { ...published, hostname },
        config.rendererReleaseId,
      );
      if (identity.renderId === input.renderId) return true;
    }
    return false;
  }

  private async listMissingCurrentContexts(): Promise<PrerenderTaskContext[]> {
    if (!this.config) return [];
    const generatedRows = await this.db
      .select({
        siteId: schema.docsSites.id,
        projectId: schema.docsSites.projectId,
        projectSlug: schema.docsSites.slug,
        publishedVersionId: schema.docsVersions.id,
        artifactPrefix: schema.docsVersions.artifactPrefix,
        manifestPath: schema.docsVersions.manifestPath,
      })
      .from(schema.docsSites)
      .innerJoin(
        schema.docsVersions,
        and(
          eq(schema.docsSites.publishedVersionId, schema.docsVersions.id),
          eq(schema.docsVersions.siteId, schema.docsSites.id),
        ),
      )
      .where(
        sql`not exists (
          select 1 from ${schema.docsPrerenderTasks}
          where ${schema.docsPrerenderTasks.siteId} = ${schema.docsSites.id}
            and ${schema.docsPrerenderTasks.publishedVersionId} = ${schema.docsVersions.id}
            and ${schema.docsPrerenderTasks.rendererReleaseId} = ${this.config.rendererReleaseId}
            and ${schema.docsPrerenderTasks.status} <> 'obsolete'
            and ${schema.docsPrerenderTasks.hostname} = (${schema.docsSites.slug} || '.' || ${this.config.docsBaseDomain})
        )`,
      )
      .orderBy(asc(schema.docsSites.id))
      .limit(RECONCILE_LIMIT);
    const generatedContexts = generatedRows.flatMap((row) => {
      const hostname = createGeneratedDocsHostname(
        row.projectSlug,
        this.config?.docsBaseDomain,
      );
      return hostname ? [{ ...row, hostname }] : [];
    });
    const remaining = Math.max(0, RECONCILE_LIMIT - generatedContexts.length);
    if (remaining === 0) return generatedContexts;
    const customRows = await this.db
      .select({
        siteId: schema.docsSites.id,
        projectId: schema.docsSites.projectId,
        projectSlug: schema.docsSites.slug,
        publishedVersionId: schema.docsVersions.id,
        artifactPrefix: schema.docsVersions.artifactPrefix,
        manifestPath: schema.docsVersions.manifestPath,
        hostname: schema.docsDomains.hostname,
      })
      .from(schema.docsDomains)
      .innerJoin(
        schema.docsSites,
        eq(schema.docsDomains.siteId, schema.docsSites.id),
      )
      .innerJoin(
        schema.docsVersions,
        and(
          eq(schema.docsSites.publishedVersionId, schema.docsVersions.id),
          eq(schema.docsVersions.siteId, schema.docsSites.id),
        ),
      )
      .where(
        and(
          eq(schema.docsDomains.kind, "custom_domain"),
          eq(schema.docsDomains.status, "active"),
          eq(schema.docsDomains.verificationStatus, "verified"),
          sql`not exists (
            select 1 from ${schema.docsPrerenderTasks}
            where ${schema.docsPrerenderTasks.siteId} = ${schema.docsSites.id}
              and ${schema.docsPrerenderTasks.publishedVersionId} = ${schema.docsVersions.id}
              and ${schema.docsPrerenderTasks.rendererReleaseId} = ${this.config.rendererReleaseId}
              and ${schema.docsPrerenderTasks.status} <> 'obsolete'
              and ${schema.docsPrerenderTasks.hostname} = ${schema.docsDomains.hostname}
          )`,
        ),
      )
      .orderBy(asc(schema.docsDomains.id))
      .limit(remaining);
    return [...generatedContexts, ...customRows];
  }
}

async function listActiveProductionHostnames(
  reader: Pick<DoxaDb, "select"> | DocsMutationTransaction,
  published: Pick<PrerenderTaskContext, "siteId" | "projectSlug">,
  docsBaseDomain: string,
): Promise<string[]> {
  const generated = createGeneratedDocsHostname(
    published.projectSlug,
    docsBaseDomain,
  );
  const custom = await reader
    .select({ hostname: schema.docsDomains.hostname })
    .from(schema.docsDomains)
    .where(
      and(
        eq(schema.docsDomains.siteId, published.siteId),
        eq(schema.docsDomains.kind, "custom_domain"),
        eq(schema.docsDomains.status, "active"),
        eq(schema.docsDomains.verificationStatus, "verified"),
      ),
    )
    .orderBy(asc(schema.docsDomains.createdAt), asc(schema.docsDomains.id));
  return [generated, ...custom.map(({ hostname }) => hostname)].filter(
    (hostname): hostname is string => Boolean(hostname),
  );
}

async function insertTask(
  db: Pick<DoxaDb, "insert"> | DocsMutationTransaction,
  context: PrerenderTaskContext,
  rendererReleaseId: string,
  reason: DocsPrerenderTaskReason,
): Promise<string | null> {
  const identity = await createTaskIdentity(context, rendererReleaseId);
  const [task] = await db
    .insert(schema.docsPrerenderTasks)
    .values({
      siteId: context.siteId,
      publishedVersionId: context.publishedVersionId,
      hostname: context.hostname,
      trustedRequestOrigin: identity.trustedRequestOrigin,
      artifactPrefix: identity.artifactPrefix,
      sourceManifestPath: identity.sourceManifestPath,
      sourceArtifactVersion: identity.sourceArtifactVersion,
      artifactIdentity: identity.artifactIdentity,
      rendererReleaseId: identity.rendererReleaseId,
      renderContextId: identity.renderContextId,
      renderId: identity.renderId,
      reason,
    })
    // A rollback republishes an identity that an earlier change retired.
    // Reviving that row restores the task, and the garbage collector keeps
    // the objects because its own check finds the render current again.
    .onConflictDoUpdate({
      target: [
        schema.docsPrerenderTasks.siteId,
        schema.docsPrerenderTasks.artifactIdentity,
        schema.docsPrerenderTasks.rendererReleaseId,
        schema.docsPrerenderTasks.renderContextId,
      ],
      set: {
        publishedVersionId: context.publishedVersionId,
        reason,
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: sql`now()`,
        claimToken: null,
        leaseDeadline: null,
        heartbeatAt: null,
        completedRoutes: 0,
        totalRoutes: 0,
        lastErrorCode: null,
        lastErrorMessage: null,
        completedAt: null,
        updatedAt: sql`now()`,
      },
      setWhere: eq(schema.docsPrerenderTasks.status, "obsolete"),
    })
    .returning({ id: schema.docsPrerenderTasks.id });
  return task?.id ?? null;
}

function createTaskIdentity(
  context: PrerenderTaskContext,
  rendererReleaseId: string,
): Promise<PrerenderIdentity> {
  return createPrerenderIdentity({
    siteId: context.siteId,
    artifactPrefix: context.artifactPrefix,
    sourceManifestPath: context.manifestPath,
    rendererReleaseId,
    trustedRequestOrigin: `https://${context.hostname}`,
  });
}

function toTaskPayload(
  task: ClaimedTaskContext,
  accessPolicy: DocsAccessPolicy,
): PrerenderTaskPayload {
  if (!task.claimToken) throw new Error("Claimed pre-render task has no token.");
  const identity = toStoredIdentity(task);
  const resolution: DocsHostResolution = {
    siteId: task.siteId,
    projectId: task.projectId,
    projectSlug: task.projectSlug,
    publishedVersionId: task.publishedVersionId,
    artifactPrefix: task.artifactPrefix,
    manifestPath: task.sourceManifestPath,
    accessPolicy,
  };
  return {
    taskId: task.id,
    claimToken: task.claimToken,
    attempt: task.attemptCount,
    reason: task.reason,
    resolution,
    identity,
  };
}

function toStoredIdentity(task: TaskRow): PrerenderIdentity {
  return prerenderIdentitySchema.parse({
    siteId: task.siteId,
    renderId: task.renderId,
    artifactIdentity: task.artifactIdentity,
    rendererReleaseId: task.rendererReleaseId,
    renderContextId: task.renderContextId,
    artifactPrefix: task.artifactPrefix,
    sourceManifestPath: task.sourceManifestPath,
    sourceArtifactVersion: task.sourceArtifactVersion,
    trustedRequestOrigin: task.trustedRequestOrigin,
  });
}

function ownedRunningClaim(input: {
  taskId: string;
  claimToken: string;
}) {
  return and(
    eq(schema.docsPrerenderTasks.id, input.taskId),
    eq(schema.docsPrerenderTasks.status, "running"),
    eq(schema.docsPrerenderTasks.claimToken, input.claimToken),
    gt(schema.docsPrerenderTasks.leaseDeadline, sql`now()`),
  );
}

function sameStoredIdentity(
  task: TaskRow,
  identity: PrerenderIdentity,
): boolean {
  return (
    task.siteId === identity.siteId &&
    task.renderId === identity.renderId &&
    task.artifactIdentity === identity.artifactIdentity &&
    task.rendererReleaseId === identity.rendererReleaseId &&
    task.renderContextId === identity.renderContextId &&
    task.artifactPrefix === identity.artifactPrefix &&
    task.sourceManifestPath === identity.sourceManifestPath &&
    task.sourceArtifactVersion === identity.sourceArtifactVersion &&
    task.trustedRequestOrigin === identity.trustedRequestOrigin
  );
}

export function retryDelaySeconds(
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(30 * 2 ** Math.max(0, attempt - 1), 15 * 60);
  const jitter = Math.floor(exponential * 0.2 * random());
  return Math.min(exponential + jitter, 15 * 60);
}

function sanitizeError(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function fenceResult(rows: Array<{ id: string }>): PrerenderTaskFenceResult {
  return rows.length > 0 ? { status: "accepted" } : { status: "stale" };
}
