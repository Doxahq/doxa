import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { createDb, schema, type DoxaDb } from "@doxahq/db";
import type {
  GenerationControlDto,
  GenerationActionBlockedReason,
  GenerationDetailDto,
  GenerationExecutionContext,
  GenerationProfile,
  GenerationJobDto,
  GenerationsPageDto,
  JobEventDto,
  JobEventSource,
  SourceAuthor,
  SourceProvider,
  StaleGenerationJobDto,
} from "@doxahq/contracts";
import type { Env } from "../env";
import {
  GENERATION_PAGE_FLAGGED_EVENT_TYPE,
  GENERATION_PAGE_NOTICE_EVENT_TYPE,
  type FlaggedPage,
  type PageNotice,
} from "@doxahq/contracts/generation-reviews";
import {
  WORKFLOW_STEP_FAILED_EVENT_TYPE,
  workflowStepFailureSchema,
  type ReferenceSourceReport,
} from "@doxahq/contracts";
import {
  ANALYSIS_COMPLETE_EVENT_TYPE,
  appendJobEvent,
  flaggedPagesFromEvents,
  pageNoticesFromEvents,
  referenceSourceFromEvents,
  RERUN_EVENT_TYPES,
  toJobEventDto,
} from "./job-events";
import { withDocsPublicationEffects } from "./docs-cache-mutation";
import { recordPublication } from "./docs-publications";
import { retireDocsVersion } from "./docs-version-retirement";
import { resolveRetentionPolicy } from "../services/retention-policy";
import {
  encodeGenerationCursor,
  type GenerationCursorPosition,
} from "../utils/generation-pagination";
import {
  isGenerationServingProduction,
  toGenerationDetailDto,
  type RecordedStepFailure,
  type RerunEventRow,
} from "./generation-detail";
import {
  getDeleteBlockedReason,
  awaitsGenerationReview,
  getPromoteBlockedReason,
  promoteRetentionFacts,
  type GenerationRunReview,
} from "../services/generation-actions";
import { nextDocsVersionNumber } from "./docs-version-numbers";
import { isUniqueViolation } from "./postgres-errors";

const GLOBAL_CONTROL_ID = "global";
const ACTIVE_JOB_STATUSES = ["queued", "running"] as const;
const PRODUCTION_CONCURRENCY_PREFIX = "publish";
const PREVIEW_CONCURRENCY_PREFIX = "preview";
/** A run id stored in event data, checked before it reaches a `uuid` column. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function productionConcurrencyKey(projectId: string): string {
  return `${PRODUCTION_CONCURRENCY_PREFIX}:${projectId}`;
}

export function previewConcurrencyKey(input: {
  projectId: string;
  provider: "github";
  changeExternalId: string;
}): string {
  return [
    PREVIEW_CONCURRENCY_PREFIX,
    input.projectId,
    input.provider,
    input.changeExternalId,
  ].join(":");
}

export interface GenerationStreamState {
  generation: GenerationJobDto;
  latestSequence: number;
}

export interface CreateDoxabotGenerationJobInput {
  projectId: string;
  provider: SourceProvider;
  sourceInstallationExternalId: string;
  sourceAuthor: SourceAuthor | null;
  changeProposalId: string;
  changeExternalId: string;
  baselineRevision: string | null;
  targetRevision: string;
  sourceTreeHash: string | null;
  baselineVersionId: string | null;
  plannerModel: string;
  writerModel: string;
  generationProfile: GenerationProfile;
  planningFingerprint: string;
  writingFingerprint: string;
  generatorFingerprint: string;
  idempotencyKey: string;
  concurrencyKey: string;
}

/** A production run starts from a person, or from Doxabot after merges. */
export type ProductionGenerationTrigger = "manual" | "merge";

export interface CreateProductionGenerationJobInput {
  projectId: string;
  userId: string;
  trigger: ProductionGenerationTrigger;
  baselineRevision: string;
  targetRevision: string;
  sourceTreeHash: string | null;
  baselineVersionId: string | null;
  /** The hand-written version that a seeded first run reads, or null. */
  seedVersionId: string | null;
  plannerModel: string;
  writerModel: string;
  generationProfile: GenerationProfile;
  planningFingerprint: string;
  writingFingerprint: string;
  generatorFingerprint: string;
}

export type ProductionGenerationJobAdmission =
  | { outcome: "created"; job: GenerationJobDto }
  | { outcome: "already_active"; job: GenerationJobDto };

/**
 * Raised when the active-generation index rejects the insert but the blocking
 * job is already gone. The caller must answer with a conflict, not a failure.
 */
export class ActiveGenerationConflictError extends Error {
  constructor(
    message = "A generation is already in progress for this project.",
  ) {
    super(message);
    this.name = "ActiveGenerationConflictError";
  }
}

export interface DoxabotGenerationJobCreation {
  outcome: "created" | "replayed";
  job: GenerationJobDto;
  queuePublished: boolean;
}

export type DoxabotGenerationJobAdmission =
  | DoxabotGenerationJobCreation
  | { outcome: "concurrency_conflict" };

/** What an ended run needs to run again, read from the run itself. */
export interface GenerationRerunSource {
  id: string;
  projectId: string;
  status: GenerationJobDto["status"];
  publicationMode: "production" | "preview";
  supersededByJobId: string | null;
  sourceProvider: SourceProvider | null;
  sourceInstallationExternalId: string | null;
  sourceAuthor: SourceAuthor | null;
  changeExternalId: string | null;
}

/** A preview run that a person starts again, which no webhook delivery carries. */
export type PreviewRerunJobInput = CreateDoxabotGenerationJobInput & {
  rerunOfJobId: string;
};

export interface DoxabotGenerationJobsStore {
  admitDoxabotJob(
    input: CreateDoxabotGenerationJobInput & { deliveryId: string },
  ): Promise<DoxabotGenerationJobAdmission>;
  activeForConcurrencyKey(
    concurrencyKey: string,
  ): Promise<GenerationJobDto | null>;
  markCancelled(
    jobId: string,
    message: string,
    eventType?: string,
    data?: Record<string, unknown>,
  ): Promise<boolean>;
  linkSupersededJob(input: {
    supersededJobId: string;
    supersedingJobId: string;
  }): Promise<void>;
  addEvent(
    jobId: string,
    type: string,
    message: string,
    data?: Record<string, unknown>,
    source?: JobEventSource,
  ): Promise<JobEventDto>;
}

export interface PendingDoxabotQueuePublication {
  provider: SourceProvider;
  deliveryId: string;
  jobId: string;
  projectId: string;
  ownerUserId: string;
}

export interface DoxabotQueueOutboxJobsStore {
  listPendingDoxabotQueuePublications(
    limit: number,
  ): Promise<PendingDoxabotQueuePublication[]>;
}

export interface ReviewRunJobContext {
  jobId: string;
  provider: SourceProvider;
  targetRevision: string;
  externalReviewRunId: string | null;
  repository: {
    externalId: string;
    owner: string;
    name: string;
    installationExternalId: string;
  };
}

export type ReviewRunClaim =
  | { outcome: "claimed"; reconcile: boolean }
  | { outcome: "existing"; externalRunId: string }
  | { outcome: "pending" }
  | { outcome: "not_found" };

export interface ReviewRunJobsStore {
  getReviewRunContext(jobId: string): Promise<ReviewRunJobContext | null>;
  claimReviewRun(input: {
    jobId: string;
    claimToken: string;
    claimedAt: Date;
  }): Promise<ReviewRunClaim>;
  completeReviewRunClaim(input: {
    jobId: string;
    claimToken: string;
    claimedAt: Date;
    externalRunId: string;
  }): Promise<boolean>;
}

type JobsRepositoryEnv = Pick<
  Env,
  | "DATABASE_URL"
  | "HYPERDRIVE"
  | "DOCS_BASE_DOMAIN"
  | "DOCS_RENDERER_BASE_URL"
  | "DOCS_RUNTIME_URL"
  | "DOCS_CACHE_INVALIDATOR"
  | "DOXA_RENDERER_RELEASE_ID"
  | "PRERENDER_QUEUE"
>;

const publishedDocsVersions = alias(
  schema.docsVersions,
  "published_docs_versions",
);

export type PromoteGenerationOutcome =
  | { outcome: "promoted"; publishedVersionId: string }
  | { outcome: "blocked"; reason: GenerationActionBlockedReason }
  | { outcome: "not_found" };

export type DeleteGenerationOutcome =
  | { outcome: "deleted" }
  | { outcome: "blocked"; reason: GenerationActionBlockedReason }
  | { outcome: "not_found" };

export class JobsRepository
  implements
    DoxabotGenerationJobsStore,
    DoxabotQueueOutboxJobsStore,
    ReviewRunJobsStore
{
  private readonly db;
  private readonly env: JobsRepositoryEnv;

  constructor(env: JobsRepositoryEnv) {
    this.env = env;
    this.db = createDb(env);
  }

  async create(
    input: CreateProductionGenerationJobInput,
  ): Promise<ProductionGenerationJobAdmission> {
    let job: typeof schema.generationJobs.$inferSelect;
    const concurrencyKey = productionConcurrencyKey(input.projectId);

    try {
      [job] = await this.db
        .insert(schema.generationJobs)
        .values({
          projectId: input.projectId,
          requestedByUserId: input.userId,
          trigger: input.trigger,
          publicationMode: "production",
          baselineRevision: input.baselineRevision,
          targetRevision: input.targetRevision,
          sourceTreeHash: input.sourceTreeHash,
          baselineVersionId: input.baselineVersionId,
          seedVersionId: input.seedVersionId,
          agentModel: input.writerModel,
          plannerModel: input.plannerModel,
          writerModel: input.writerModel,
          planningFingerprint: input.planningFingerprint,
          writingFingerprint: input.writingFingerprint,
          generationProfile: input.generationProfile,
          generatorFingerprint: input.generatorFingerprint,
          idempotencyKey: `${input.trigger}:${crypto.randomUUID()}`,
          concurrencyKey,
        })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err, "generation_jobs_active_concurrency_idx")) {
        const active = await this.activeForConcurrencyKey(concurrencyKey);
        if (active) return { outcome: "already_active", job: active };
        throw new ActiveGenerationConflictError();
      }
      throw err;
    }

    await this.addEvent(job.id, "queued", "Generation job queued.");
    return { outcome: "created", job: toJobDto(job) };
  }

  /** The run, scoped to a project of the user, as a re-run reads it. */
  async getRerunSource(input: {
    userId: string;
    projectId: string;
    jobId: string;
  }): Promise<GenerationRerunSource | null> {
    const [row] = await this.db
      .select({ job: schema.generationJobs })
      .from(schema.generationJobs)
      .innerJoin(
        schema.projects,
        eq(schema.generationJobs.projectId, schema.projects.id),
      )
      .where(
        and(
          eq(schema.projects.userId, input.userId),
          eq(schema.generationJobs.projectId, input.projectId),
          eq(schema.generationJobs.id, input.jobId),
        ),
      )
      .limit(1);
    if (!row) return null;

    const { job } = row;
    return {
      id: job.id,
      projectId: job.projectId,
      status: job.status,
      publicationMode: job.publicationMode,
      supersededByJobId: job.supersededByJobId,
      sourceProvider: job.sourceProvider,
      sourceInstallationExternalId: job.sourceInstallationExternalId,
      sourceAuthor:
        job.sourceAuthorExternalId && job.sourceAuthorHandle
          ? {
              externalId: job.sourceAuthorExternalId,
              handle: job.sourceAuthorHandle,
              avatarUrl: job.sourceAuthorAvatarUrl,
            }
          : null,
      changeExternalId: job.changeExternalId,
    };
  }

  /**
   * Admits a preview run that a person starts again. It has no webhook
   * delivery, so the caller publishes it to the queue. Another active run
   * for the pull request makes it a concurrency conflict.
   */
  async admitPreviewRerun(
    input: PreviewRerunJobInput,
  ): Promise<DoxabotGenerationJobAdmission> {
    return this.db.transaction(async (transaction) => {
      const requestedByUserId = await findSourceAuthorUserId(
        transaction,
        input,
      );
      const [created] = await transaction
        .insert(schema.generationJobs)
        .values(doxabotJobValues(input, requestedByUserId))
        .onConflictDoNothing()
        .returning();
      if (!created) return { outcome: "concurrency_conflict" };

      await appendJobEvent(transaction, {
        jobId: created.id,
        type: "doxabot_queued",
        message: "Preview generation queued again from an earlier run.",
        data: {
          provider: input.provider,
          changeExternalId: input.changeExternalId,
          targetRevision: input.targetRevision,
          rerunOfJobId: input.rerunOfJobId,
        },
        source: "system",
      });

      return {
        outcome: "created",
        job: toJobDto(created),
        queuePublished: false,
      };
    });
  }

  async admitDoxabotJob(
    input: CreateDoxabotGenerationJobInput & { deliveryId: string },
  ): Promise<DoxabotGenerationJobAdmission> {
    return this.db.transaction(async (transaction) => {
      const requestedByUserId = await findSourceAuthorUserId(
        transaction,
        input,
      );
      const [created] = await transaction
        .insert(schema.generationJobs)
        .values(doxabotJobValues(input, requestedByUserId))
        .onConflictDoNothing()
        .returning();

      if (!created) {
        const [replayed] = await transaction
          .select()
          .from(schema.generationJobs)
          .where(eq(schema.generationJobs.idempotencyKey, input.idempotencyKey))
          .limit(1);
        if (!replayed) return { outcome: "concurrency_conflict" };

        const [publishedDelivery] = await transaction
          .select({
            queuePublishedAt: schema.scmWebhookDeliveries.queuePublishedAt,
          })
          .from(schema.scmWebhookDeliveries)
          .where(
            and(
              eq(schema.scmWebhookDeliveries.generationJobId, replayed.id),
              isNotNull(schema.scmWebhookDeliveries.queuePublishedAt),
            ),
          )
          .limit(1);
        await linkDoxabotDelivery(transaction, {
          provider: input.provider,
          deliveryId: input.deliveryId,
          jobId: replayed.id,
          queuePublishedAt: publishedDelivery?.queuePublishedAt ?? null,
        });
        return {
          outcome: "replayed",
          job: toJobDto(replayed),
          queuePublished: Boolean(publishedDelivery),
        };
      }

      await linkDoxabotDelivery(transaction, {
        provider: input.provider,
        deliveryId: input.deliveryId,
        jobId: created.id,
        queuePublishedAt: null,
      });
      await appendJobEvent(transaction, {
        jobId: created.id,
        type: "doxabot_queued",
        message: "Doxabot preview generation queued.",
        data: {
          provider: input.provider,
          changeExternalId: input.changeExternalId,
          targetRevision: input.targetRevision,
        },
        source: "system",
      });

      return {
        outcome: "created",
        job: toJobDto(created),
        queuePublished: false,
      };
    });
  }

  async listPendingDoxabotQueuePublications(
    limit: number,
  ): Promise<PendingDoxabotQueuePublication[]> {
    return this.db
      .selectDistinctOn([schema.generationJobs.id], {
        provider: schema.scmWebhookDeliveries.provider,
        deliveryId: schema.scmWebhookDeliveries.deliveryId,
        jobId: schema.generationJobs.id,
        projectId: schema.generationJobs.projectId,
        ownerUserId: schema.projects.userId,
      })
      .from(schema.scmWebhookDeliveries)
      .innerJoin(
        schema.generationJobs,
        eq(
          schema.scmWebhookDeliveries.generationJobId,
          schema.generationJobs.id,
        ),
      )
      .innerJoin(
        schema.projects,
        eq(schema.generationJobs.projectId, schema.projects.id),
      )
      .where(
        and(
          isNull(schema.scmWebhookDeliveries.queuePublishedAt),
          inArray(schema.scmWebhookDeliveries.status, [
            "claimed",
            "enqueue_failed",
            "failed",
          ]),
          eq(schema.generationJobs.trigger, "doxabot"),
          eq(schema.generationJobs.status, "queued"),
        ),
      )
      .orderBy(
        schema.generationJobs.id,
        asc(schema.scmWebhookDeliveries.createdAt),
      )
      .limit(limit);
  }

  /** The project of a generation, so a route can authorize before it reads. */
  async findProjectId(jobId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ projectId: schema.generationJobs.projectId })
      .from(schema.generationJobs)
      .where(eq(schema.generationJobs.id, jobId))
      .limit(1);
    return row?.projectId ?? null;
  }

  /** Owner-scoped: callers pass the project owner's ID from the access policy. */
  async getForUser(
    userId: string,
    jobId: string,
  ): Promise<GenerationJobDto | null> {
    const [row] = await this.db
      .select({
        job: schema.generationJobs,
      })
      .from(schema.generationJobs)
      .innerJoin(
        schema.projects,
        eq(schema.generationJobs.projectId, schema.projects.id),
      )
      .where(
        and(
          eq(schema.generationJobs.id, jobId),
          eq(schema.projects.userId, userId),
        ),
      )
      .limit(1);

    return row ? toJobDto(row.job) : null;
  }

  async listForProject(input: {
    userId: string;
    projectId: string;
    limit: number;
    cursor: GenerationCursorPosition | null;
  }): Promise<GenerationsPageDto> {
    const cursorCondition = input.cursor
      ? or(
          sql`${schema.generationJobs.createdAt} < ${input.cursor.createdAt}::timestamptz`,
          and(
            sql`${schema.generationJobs.createdAt} = ${input.cursor.createdAt}::timestamptz`,
            lt(schema.generationJobs.id, input.cursor.id),
          ),
        )
      : undefined;

    const rows = await this.db
      .select({
        job: schema.generationJobs,
        cursorCreatedAt: sql<string>`to_char(${schema.generationJobs.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(schema.generationJobs)
      .innerJoin(
        schema.projects,
        eq(schema.generationJobs.projectId, schema.projects.id),
      )
      .where(
        and(
          eq(schema.projects.userId, input.userId),
          eq(schema.generationJobs.projectId, input.projectId),
          cursorCondition,
        ),
      )
      .orderBy(
        desc(schema.generationJobs.createdAt),
        desc(schema.generationJobs.id),
      )
      .limit(input.limit + 1);

    const hasNextPage = rows.length > input.limit;
    const pageRows = rows.slice(0, input.limit);
    const lastRow = pageRows.at(-1);

    return {
      generations: pageRows.map((row) => toJobDto(row.job)),
      nextCursor:
        hasNextPage && lastRow
          ? encodeGenerationCursor({
              createdAt: lastRow.cursorCreatedAt,
              id: lastRow.job.id,
            })
          : null,
    };
  }

  async getForProject(input: {
    userId: string;
    projectId: string;
    jobId: string;
  }): Promise<GenerationJobDto | null> {
    const [row] = await this.db
      .select({ job: schema.generationJobs })
      .from(schema.generationJobs)
      .innerJoin(
        schema.projects,
        eq(schema.generationJobs.projectId, schema.projects.id),
      )
      .where(
        and(
          eq(schema.projects.userId, input.userId),
          eq(schema.generationJobs.projectId, input.projectId),
          eq(schema.generationJobs.id, input.jobId),
        ),
      )
      .limit(1);

    return row ? toJobDto(row.job) : null;
  }

  async getDetailForProject(input: {
    userId: string;
    projectId: string;
    jobId: string;
  }): Promise<GenerationDetailDto | null> {
    const [row] = await this.db
      .select({
        job: schema.generationJobs,
        projectSlug: schema.projects.slug,
        userName: schema.user.name,
        userGithubLogin: schema.user.githubLogin,
        userImage: schema.user.image,
        repositoryFullName: schema.githubRepositories.fullName,
        repositoryDefaultBranch: schema.githubRepositories.defaultBranch,
        changeProposalNumber: schema.scmChangeProposals.displayNumber,
        changeProposalState: schema.scmChangeProposals.state,
        siteId: schema.docsSites.id,
        publishedVersionId: schema.docsSites.publishedVersionId,
        versionId: schema.docsVersions.id,
        versionNumber: schema.docsVersions.versionNumber,
        versionArtifactPrefix: schema.docsVersions.artifactPrefix,
        versionStatus: schema.docsVersions.status,
        versionChannel: schema.docsVersions.channel,
        versionPreviewReplacedAt: schema.docsVersions.previewReplacedAt,
        versionCollectedAt: schema.docsVersions.artifactsCollectedAt,
        publishedBaselineVersionId: publishedDocsVersions.baselineVersionId,
        publishedArtifactPrefix: publishedDocsVersions.artifactPrefix,
        reviewStatus: schema.generationReviews.status,
        reviewPublishedVersionId: schema.generationReviews.publishedVersionId,
      })
      .from(schema.generationJobs)
      .innerJoin(
        schema.projects,
        eq(schema.generationJobs.projectId, schema.projects.id),
      )
      .leftJoin(
        schema.user,
        eq(schema.generationJobs.requestedByUserId, schema.user.id),
      )
      .leftJoin(
        schema.githubRepositories,
        eq(schema.projects.githubRepositoryId, schema.githubRepositories.id),
      )
      .leftJoin(
        schema.scmChangeProposals,
        eq(
          schema.generationJobs.changeProposalId,
          schema.scmChangeProposals.id,
        ),
      )
      .leftJoin(
        schema.docsSites,
        eq(schema.docsSites.projectId, schema.projects.id),
      )
      .leftJoin(
        schema.docsVersions,
        eq(schema.generationJobs.docsVersionId, schema.docsVersions.id),
      )
      .leftJoin(
        publishedDocsVersions,
        eq(schema.docsSites.publishedVersionId, publishedDocsVersions.id),
      )
      // A run has one review at most (generation_reviews_job_idx).
      .leftJoin(
        schema.generationReviews,
        eq(schema.generationReviews.jobId, schema.generationJobs.id),
      )
      .where(
        and(
          eq(schema.projects.userId, input.userId),
          eq(schema.generationJobs.projectId, input.projectId),
          eq(schema.generationJobs.id, input.jobId),
        ),
      )
      .limit(1);

    if (!row) return null;

    const productionDomains =
      row.job.publicationMode === "production" && row.siteId
        ? await this.db
            .select({
              hostname: schema.docsDomains.hostname,
              kind: schema.docsDomains.kind,
              status: schema.docsDomains.status,
              verificationStatus: schema.docsDomains.verificationStatus,
            })
            .from(schema.docsDomains)
            .where(
              and(
                eq(schema.docsDomains.projectId, input.projectId),
                eq(schema.docsDomains.siteId, row.siteId),
              ),
            )
        : [];

    const previewChannel =
      row.job.publicationMode === "preview" &&
      row.siteId &&
      row.job.sourceProvider &&
      row.job.changeExternalId
        ? await this.findPreviewChannel({
            projectId: input.projectId,
            siteId: row.siteId,
            provider: row.job.sourceProvider,
            changeExternalId: row.job.changeExternalId,
          })
        : null;

    return toGenerationDetailDto({
      job: row.job,
      projectSlug: row.projectSlug,
      user: row.userName
        ? {
            name: row.userName,
            githubLogin: row.userGithubLogin,
            image: row.userImage,
          }
        : null,
      repository:
        row.repositoryFullName && row.repositoryDefaultBranch
          ? {
              fullName: row.repositoryFullName,
              defaultBranch: row.repositoryDefaultBranch,
            }
          : null,
      changeProposal:
        row.changeProposalNumber && row.changeProposalState
          ? {
              displayNumber: row.changeProposalNumber,
              state: row.changeProposalState,
            }
          : null,
      site: row.siteId ? { publishedVersionId: row.publishedVersionId } : null,
      version:
        row.versionId &&
        row.versionNumber &&
        row.versionArtifactPrefix &&
        row.versionStatus
          ? {
              id: row.versionId,
              versionNumber: row.versionNumber,
              artifactPrefix: row.versionArtifactPrefix,
              status: row.versionStatus,
              retention: row.versionChannel
                ? {
                    channel: row.versionChannel,
                    previewReplacedAt: row.versionPreviewReplacedAt,
                    artifactsCollectedAt: row.versionCollectedAt,
                  }
                : undefined,
            }
          : null,
      publishedVersion:
        row.publishedVersionId && row.publishedArtifactPrefix
          ? {
              id: row.publishedVersionId,
              baselineVersionId: row.publishedBaselineVersionId,
              artifactPrefix: row.publishedArtifactPrefix,
            }
          : null,
      review: row.reviewStatus
        ? { status: row.reviewStatus, publishedVersionId: row.reviewPublishedVersionId }
        : null,
      productionDomains,
      previewChannel,
      flaggedPages: await this.listFlaggedPages(input.jobId),
      referenceSource: await this.findReferenceSource(input.jobId),
      stepFailure: row.job.status === "failed" ? await this.latestStepFailure(input.jobId) : null,
      rerunEvents: await this.findRerunEvents({
        projectId: input.projectId,
        jobId: input.jobId,
      }),
      env: this.env,
    });
  }

  /**
   * The re-run events of a run, newest first. An event whose other run was
   * deleted, or belongs to another project, is left out.
   */
  private async findRerunEvents(input: {
    projectId: string;
    jobId: string;
  }): Promise<RerunEventRow[]> {
    const events = await this.db
      .select({ type: schema.jobEvents.type, data: schema.jobEvents.data })
      .from(schema.jobEvents)
      .where(
        and(
          eq(schema.jobEvents.jobId, input.jobId),
          inArray(schema.jobEvents.type, Object.values(RERUN_EVENT_TYPES)),
        ),
      )
      .orderBy(desc(schema.jobEvents.sequence));
    const linked = events.flatMap((event) => {
      const linkedJobId = event.data?.jobId;
      return typeof linkedJobId === "string" && UUID_PATTERN.test(linkedJobId)
        ? [{ type: event.type, linkedJobId }]
        : [];
    });
    if (linked.length === 0) return [];

    const existing = await this.db
      .select({ id: schema.generationJobs.id })
      .from(schema.generationJobs)
      .where(
        and(
          eq(schema.generationJobs.projectId, input.projectId),
          inArray(
            schema.generationJobs.id,
            linked.map((event) => event.linkedJobId),
          ),
        ),
      );
    const existingIds = new Set(existing.map((row) => row.id));
    return linked.filter((event) => existingIds.has(event.linkedJobId));
  }

  async promoteForProject(input: {
    userId: string;
    projectId: string;
    jobId: string;
  }): Promise<PromoteGenerationOutcome> {
    return withDocsPublicationEffects(
      this.db,
      this.env,
      async (transaction, enqueue, enqueuePrerender) => {
        const context = await getLockedGenerationContext(transaction, input);
        if (!context) return { outcome: "not_found" };

        const promoteBlockedReason = getPromoteBlockedReason({
          status: context.job.status,
          docsVersionId: context.job.docsVersionId,
          publishedVersionId: context.site?.publishedVersionId ?? null,
          awaitsReview: awaitsGenerationReview({
            publicationMode: context.job.publicationMode,
            versionStatus: context.sourceVersion?.status ?? null,
            review: context.review,
          }),
          isServingProduction: isGenerationServingProduction({
            generationVersion: context.sourceVersion,
            publishedVersion: context.publishedVersion,
            reviewedVersionId: context.review?.publishedVersionId ?? null,
          }),
          // The site row lock orders this after a collector that marks the
          // version as collected.
          ...promoteRetentionFacts(
            context.sourceVersion,
            resolveRetentionPolicy({ id: input.projectId }),
            new Date(),
          ),
        });
        if (promoteBlockedReason) {
          return {
            outcome: "blocked",
            reason: promoteBlockedReason,
          };
        }
        if (!context.site || !context.sourceVersion) {
          return { outcome: "blocked", reason: "no_docs_version" };
        }

        const versionNumber = await nextDocsVersionNumber(transaction, {
          siteId: context.site.id,
          channel: "production",
        });
        const [publishedVersion] = await transaction
          .insert(schema.docsVersions)
          .values({
            siteId: context.site.id,
            versionNumber,
            status: "published",
            channel: "production",
            artifactPrefix: context.sourceVersion.artifactPrefix,
            manifestPath: context.sourceVersion.manifestPath,
            sourceRevision: context.sourceVersion.sourceRevision,
            sourceTreeHash: context.sourceVersion.sourceTreeHash,
            baselineVersionId: context.sourceVersion.id,
            generatorFingerprint: context.sourceVersion.generatorFingerprint,
            generationStatePrefix: context.sourceVersion.generationStatePrefix,
          })
          .returning({ id: schema.docsVersions.id });

        await transaction
          .update(schema.docsSites)
          .set({
            publishedVersionId: publishedVersion.id,
            updatedAt: new Date(),
          })
          .where(eq(schema.docsSites.id, context.site.id));
        await recordPublication(transaction, {
          siteId: context.site.id,
          versionId: publishedVersion.id,
          previousVersionId: context.site.publishedVersionId,
          kind: "promotion",
          actorUserId: input.userId,
          branchName: null,
          summary: {},
        });
        await enqueue({ siteId: context.site.id });
        await enqueuePrerender({
          siteId: context.site.id,
          publishedVersionId: publishedVersion.id,
          reason: "promotion",
        });
        await appendJobEvent(transaction, {
          jobId: context.job.id,
          type: "promoted",
          source: "api",
          message: "Generation promoted to production.",
          data: {
            versionId: publishedVersion.id,
            previousVersionId: context.site.publishedVersionId,
          },
        });

        return {
          outcome: "promoted",
          publishedVersionId: publishedVersion.id,
        };
      },
    );
  }

  async deleteForProject(input: {
    userId: string;
    projectId: string;
    jobId: string;
  }): Promise<DeleteGenerationOutcome> {
    return this.db.transaction(async (transaction) => {
      const context = await getLockedGenerationContext(transaction, input);
      if (!context) return { outcome: "not_found" };

      const [servingPreview] = context.job.docsVersionId
        ? await transaction
            .select({ id: schema.docsPreviewChannels.id })
            .from(schema.docsPreviewChannels)
            .where(
              and(
                eq(schema.docsPreviewChannels.projectId, input.projectId),
                eq(
                  schema.docsPreviewChannels.currentVersionId,
                  context.job.docsVersionId,
                ),
                eq(schema.docsPreviewChannels.lifecycleState, "active"),
              ),
            )
            .limit(1)
        : [];
      const deleteBlockedReason = getDeleteBlockedReason({
        status: context.job.status,
        docsVersionId: context.job.docsVersionId,
        publishedVersionId: context.site?.publishedVersionId ?? null,
        isServingProduction: isGenerationServingProduction({
          generationVersion: context.sourceVersion,
          publishedVersion: context.publishedVersion,
          reviewedVersionId: context.review?.publishedVersionId ?? null,
        }),
        isServingPreview: Boolean(servingPreview),
      });
      if (deleteBlockedReason) {
        return {
          outcome: "blocked",
          reason: deleteBlockedReason,
        };
      }

      await transaction
        .delete(schema.generationJobs)
        .where(eq(schema.generationJobs.id, context.job.id));
      // The version row stays in the history. Its folder and generation
      // state go when no version that shares them is kept. The R2 lifecycle
      // rule of `_generation-checkpoints/` expires the run's checkpoints.
      if (context.site && context.job.docsVersionId) {
        await retireDocsVersion(
          transaction,
          { siteId: context.site.id, versionId: context.job.docsVersionId },
          "generation_deleted",
        );
      }
      return { outcome: "deleted" };
    });
  }

  private async findPreviewChannel(input: {
    projectId: string;
    siteId: string;
    provider: SourceProvider;
    changeExternalId: string;
  }): Promise<{
    hostname: string;
    currentVersionId: string | null;
  } | null> {
    const [channel] = await this.db
      .select({
        hostname: schema.docsPreviewChannels.hostname,
        currentVersionId: schema.docsPreviewChannels.currentVersionId,
      })
      .from(schema.docsPreviewChannels)
      .where(
        and(
          eq(schema.docsPreviewChannels.projectId, input.projectId),
          eq(schema.docsPreviewChannels.siteId, input.siteId),
          eq(schema.docsPreviewChannels.provider, input.provider),
          eq(
            schema.docsPreviewChannels.changeExternalId,
            input.changeExternalId,
          ),
        ),
      )
      .limit(1);
    return channel ?? null;
  }

  /** When the newest event of a type was added to the run, or null. */
  async latestEventAt(jobId: string, type: string): Promise<string | null> {
    const event = await this.latestEvent(jobId, type);
    return event ? event.createdAt.toISOString() : null;
  }

  /** The step that ended the run's last failure, when the workflow recorded one. */
  async latestStepFailure(jobId: string): Promise<RecordedStepFailure | null> {
    const event = await this.latestEvent(jobId, WORKFLOW_STEP_FAILED_EVENT_TYPE);
    const parsed = workflowStepFailureSchema.safeParse(event?.data);
    return event && parsed.success ? { failure: parsed.data, failedAt: event.createdAt } : null;
  }

  private async latestEvent(
    jobId: string,
    type: string,
  ): Promise<{ createdAt: Date; data: unknown } | null> {
    const [event] = await this.db
      .select({ createdAt: schema.jobEvents.createdAt, data: schema.jobEvents.data })
      .from(schema.jobEvents)
      .where(and(eq(schema.jobEvents.jobId, jobId), eq(schema.jobEvents.type, type)))
      .orderBy(desc(schema.jobEvents.sequence))
      .limit(1);
    return event ?? null;
  }

  /**
   * Turns a failed run back into a running one, for a resume. Returns false
   * when the run is no longer failed. Throws `ActiveGenerationConflictError`
   * when another run of the project is active.
   */
  async reopenFailedJob(jobId: string): Promise<boolean> {
    try {
      const rows = await this.db
        .update(schema.generationJobs)
        .set({ status: "running", errorMessage: null, updatedAt: new Date() })
        .where(and(eq(schema.generationJobs.id, jobId), eq(schema.generationJobs.status, "failed")))
        .returning({ id: schema.generationJobs.id });
      return rows.length > 0;
    } catch (error) {
      if (isUniqueViolation(error, "generation_jobs_active_concurrency_idx")) {
        throw new ActiveGenerationConflictError();
      }
      throw error;
    }
  }

  /** The pages that the run could not write, from its flag events. */
  async listFlaggedPages(jobId: string): Promise<FlaggedPage[]> {
    const events = await this.db
      .select({ data: schema.jobEvents.data })
      .from(schema.jobEvents)
      .where(
        and(
          eq(schema.jobEvents.jobId, jobId),
          eq(schema.jobEvents.type, GENERATION_PAGE_FLAGGED_EVENT_TYPE),
        ),
      )
      .orderBy(asc(schema.jobEvents.sequence));
    return flaggedPagesFromEvents(events);
  }

  async listPageNotices(jobId: string): Promise<PageNotice[]> {
    const events = await this.db
      .select({ data: schema.jobEvents.data })
      .from(schema.jobEvents)
      .where(
        and(
          eq(schema.jobEvents.jobId, jobId),
          eq(schema.jobEvents.type, GENERATION_PAGE_NOTICE_EVENT_TYPE),
        ),
      )
      .orderBy(asc(schema.jobEvents.sequence));
    return pageNoticesFromEvents(events);
  }

  /** The REST reference report of the run, from its analysis events. */
  async findReferenceSource(jobId: string): Promise<ReferenceSourceReport | null> {
    const events = await this.db
      .select({ data: schema.jobEvents.data })
      .from(schema.jobEvents)
      .where(
        and(
          eq(schema.jobEvents.jobId, jobId),
          eq(schema.jobEvents.type, ANALYSIS_COMPLETE_EVENT_TYPE),
        ),
      )
      .orderBy(asc(schema.jobEvents.sequence));
    return referenceSourceFromEvents(events);
  }

  async listEvents(jobId: string): Promise<JobEventDto[]> {
    const rows = await this.db
      .select()
      .from(schema.jobEvents)
      .where(eq(schema.jobEvents.jobId, jobId))
      .orderBy(asc(schema.jobEvents.sequence), asc(schema.jobEvents.createdAt));

    return rows.map(toJobEventDto);
  }

  async listEventsAfter(
    jobId: string,
    sequence: number,
    limit: number,
  ): Promise<JobEventDto[]> {
    const rows = await this.db
      .select()
      .from(schema.jobEvents)
      .where(
        and(
          eq(schema.jobEvents.jobId, jobId),
          gt(schema.jobEvents.sequence, sequence),
        ),
      )
      .orderBy(asc(schema.jobEvents.sequence))
      .limit(limit);

    return rows.map(toJobEventDto);
  }

  async getStreamStateForProject(input: {
    userId: string;
    projectId: string;
    jobId: string;
  }): Promise<GenerationStreamState | null> {
    const [row] = await this.db
      .select({ job: schema.generationJobs })
      .from(schema.generationJobs)
      .innerJoin(
        schema.projects,
        eq(schema.generationJobs.projectId, schema.projects.id),
      )
      .where(
        and(
          eq(schema.projects.userId, input.userId),
          eq(schema.generationJobs.projectId, input.projectId),
          eq(schema.generationJobs.id, input.jobId),
        ),
      )
      .limit(1);

    return row
      ? { generation: toJobDto(row.job), latestSequence: row.job.eventSequence }
      : null;
  }

  async latestForProject(projectId: string): Promise<GenerationJobDto | null> {
    const [job] = await this.db
      .select()
      .from(schema.generationJobs)
      .where(eq(schema.generationJobs.projectId, projectId))
      .orderBy(desc(schema.generationJobs.createdAt))
      .limit(1);

    return job ? toJobDto(job) : null;
  }

  async activeForProject(projectId: string): Promise<GenerationJobDto | null> {
    const [job] = await this.db
      .select()
      .from(schema.generationJobs)
      .where(
        and(
          eq(schema.generationJobs.projectId, projectId),
          inArray(schema.generationJobs.status, ["queued", "running"]),
        ),
      )
      .orderBy(desc(schema.generationJobs.createdAt))
      .limit(1);

    return job ? toJobDto(job) : null;
  }

  async activeForConcurrencyKey(
    concurrencyKey: string,
  ): Promise<GenerationJobDto | null> {
    const [job] = await this.db
      .select()
      .from(schema.generationJobs)
      .where(
        and(
          eq(schema.generationJobs.concurrencyKey, concurrencyKey),
          inArray(schema.generationJobs.status, ["queued", "running"]),
        ),
      )
      .orderBy(desc(schema.generationJobs.createdAt))
      .limit(1);

    return job ? toJobDto(job) : null;
  }

  async getByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<GenerationJobDto | null> {
    const [job] = await this.db
      .select()
      .from(schema.generationJobs)
      .where(eq(schema.generationJobs.idempotencyKey, idempotencyKey))
      .limit(1);

    return job ? toJobDto(job) : null;
  }

  async linkSupersededJob(input: {
    supersededJobId: string;
    supersedingJobId: string;
  }): Promise<void> {
    await this.db
      .update(schema.generationJobs)
      .set({
        supersededByJobId: input.supersedingJobId,
        updatedAt: new Date(),
      })
      .where(eq(schema.generationJobs.id, input.supersededJobId));
  }

  async getReviewRunContext(
    jobId: string,
  ): Promise<ReviewRunJobContext | null> {
    const [row] = await this.db
      .select({
        jobId: schema.generationJobs.id,
        provider: schema.generationJobs.sourceProvider,
        targetRevision: schema.generationJobs.targetRevision,
        externalReviewRunId: schema.generationJobs.externalReviewRunId,
        repositoryExternalId: schema.githubRepositories.githubRepoId,
        repositoryOwner: schema.githubRepositories.owner,
        repositoryName: schema.githubRepositories.name,
        installationExternalId: schema.githubInstallations.installationId,
      })
      .from(schema.generationJobs)
      .innerJoin(
        schema.projects,
        eq(schema.generationJobs.projectId, schema.projects.id),
      )
      .innerJoin(
        schema.scmChangeProposals,
        and(
          eq(
            schema.generationJobs.changeProposalId,
            schema.scmChangeProposals.id,
          ),
          eq(
            schema.generationJobs.projectId,
            schema.scmChangeProposals.projectId,
          ),
          eq(
            schema.generationJobs.sourceProvider,
            schema.scmChangeProposals.provider,
          ),
        ),
      )
      .innerJoin(
        schema.githubRepositories,
        eq(
          schema.scmChangeProposals.repositoryExternalId,
          schema.githubRepositories.githubRepoId,
        ),
      )
      .innerJoin(
        schema.githubInstallations,
        and(
          eq(
            schema.githubRepositories.installationId,
            schema.githubInstallations.id,
          ),
          eq(
            schema.generationJobs.sourceInstallationExternalId,
            schema.githubInstallations.installationId,
          ),
          eq(schema.githubInstallations.userId, schema.projects.userId),
        ),
      )
      .where(
        and(
          eq(schema.generationJobs.id, jobId),
          eq(schema.generationJobs.trigger, "doxabot"),
          eq(schema.generationJobs.publicationMode, "preview"),
        ),
      )
      .limit(1);

    if (!row || row.provider === null || row.targetRevision === null) {
      return null;
    }

    return {
      jobId: row.jobId,
      provider: row.provider,
      targetRevision: row.targetRevision,
      externalReviewRunId: row.externalReviewRunId,
      repository: {
        externalId: row.repositoryExternalId,
        owner: row.repositoryOwner,
        name: row.repositoryName,
        installationExternalId: row.installationExternalId,
      },
    };
  }

  async getGenerationExecutionContext(
    jobId: string,
  ): Promise<GenerationExecutionContext | null> {
    const [row] = await this.db
      .select({
        jobId: schema.generationJobs.id,
        trigger: schema.generationJobs.trigger,
        publicationMode: schema.generationJobs.publicationMode,
        sourceProvider: schema.generationJobs.sourceProvider,
        sourceInstallationExternalId:
          schema.generationJobs.sourceInstallationExternalId,
        changeExternalId: schema.generationJobs.changeExternalId,
        baselineRevision: schema.generationJobs.baselineRevision,
        targetRevision: schema.generationJobs.targetRevision,
        sourceTreeHash: schema.generationJobs.sourceTreeHash,
        baselineVersionId: schema.generationJobs.baselineVersionId,
        agentModel: schema.generationJobs.agentModel,
        plannerModel: schema.generationJobs.plannerModel,
        writerModel: schema.generationJobs.writerModel,
        planningFingerprint: schema.generationJobs.planningFingerprint,
        writingFingerprint: schema.generationJobs.writingFingerprint,
        generationProfile: schema.generationJobs.generationProfile,
        generatorFingerprint: schema.generationJobs.generatorFingerprint,
        externalReviewRunId: schema.generationJobs.externalReviewRunId,
        projectId: schema.projects.id,
        projectName: schema.projects.name,
        projectSlug: schema.projects.slug,
        siteId: schema.docsSites.id,
        siteSlug: schema.docsSites.slug,
        repositoryId: schema.githubRepositories.id,
        repositoryFullName: schema.githubRepositories.fullName,
        repositoryOwner: schema.githubRepositories.owner,
        repositoryName: schema.githubRepositories.name,
        repositoryDefaultBranch: schema.githubRepositories.defaultBranch,
        repositoryExternalId: schema.githubRepositories.githubRepoId,
        repositoryIsPrivate: schema.githubRepositories.isPrivate,
        repositoryInstallationId: schema.githubInstallations.installationId,
        proposalId: schema.scmChangeProposals.id,
        proposalExternalId: schema.scmChangeProposals.externalId,
        proposalNumber: schema.scmChangeProposals.displayNumber,
        proposalDraft: schema.scmChangeProposals.draft,
        proposalState: schema.scmChangeProposals.state,
        proposalBaseRef: schema.scmChangeProposals.baseRef,
        proposalBaseRevision: schema.scmChangeProposals.baseRevision,
        proposalHeadRevision: schema.scmChangeProposals.headRevision,
        proposalRepositoryExternalId:
          schema.scmChangeProposals.repositoryExternalId,
      })
      .from(schema.generationJobs)
      .innerJoin(
        schema.projects,
        eq(schema.generationJobs.projectId, schema.projects.id),
      )
      .innerJoin(
        schema.docsSites,
        eq(schema.projects.id, schema.docsSites.projectId),
      )
      .innerJoin(
        schema.githubRepositories,
        eq(schema.projects.githubRepositoryId, schema.githubRepositories.id),
      )
      .innerJoin(
        schema.githubInstallations,
        eq(
          schema.githubRepositories.installationId,
          schema.githubInstallations.id,
        ),
      )
      .leftJoin(
        schema.scmChangeProposals,
        and(
          eq(
            schema.generationJobs.changeProposalId,
            schema.scmChangeProposals.id,
          ),
          eq(
            schema.generationJobs.projectId,
            schema.scmChangeProposals.projectId,
          ),
        ),
      )
      .where(eq(schema.generationJobs.id, jobId))
      .limit(1);

    if (!row) {
      return null;
    }
    const baselineVersion = row.baselineVersionId
      ? await this.getBaselineVersion(row.baselineVersionId)
      : null;
    const currentPreviewVersionId =
      row.publicationMode === "preview" &&
      row.sourceProvider &&
      row.changeExternalId
        ? await this.getCurrentPreviewVersionId({
            projectId: row.projectId,
            siteId: row.siteId,
            provider: row.sourceProvider,
            changeExternalId: row.changeExternalId,
          })
        : null;
    const changeProposal =
      row.proposalId &&
      row.proposalExternalId &&
      row.proposalNumber &&
      row.proposalDraft !== null &&
      row.proposalState &&
      row.proposalBaseRef &&
      row.proposalBaseRevision &&
      row.proposalHeadRevision &&
      row.proposalRepositoryExternalId
        ? {
            id: row.proposalId,
            externalId: row.proposalExternalId,
            number: row.proposalNumber,
            draft: row.proposalDraft,
            state: row.proposalState,
            baseRef: row.proposalBaseRef,
            baseRevision: row.proposalBaseRevision,
            headRevision: row.proposalHeadRevision,
            repositoryExternalId: row.proposalRepositoryExternalId,
          }
        : null;

    return {
      project: {
        id: row.projectId,
        name: row.projectName,
        slug: row.projectSlug,
        siteId: row.siteId,
        siteSlug: row.siteSlug,
      },
      repository: {
        id: row.repositoryId,
        fullName: row.repositoryFullName,
        defaultBranch: row.repositoryDefaultBranch,
        installationId: row.repositoryInstallationId,
        isPrivate: row.repositoryIsPrivate,
      },
      sourceRepository: {
        externalId: row.repositoryExternalId,
        owner: row.repositoryOwner,
        name: row.repositoryName,
      },
      job: {
        id: row.jobId,
        trigger: row.trigger,
        publicationMode: row.publicationMode,
        sourceProvider: row.sourceProvider,
        sourceInstallationExternalId: row.sourceInstallationExternalId,
        changeExternalId: row.changeExternalId,
        baselineRevision: row.baselineRevision,
        targetRevision: row.targetRevision,
        sourceTreeHash: row.sourceTreeHash,
        baselineVersionId: row.baselineVersionId,
        agentModel: row.agentModel,
        plannerModel: row.plannerModel,
        writerModel: row.writerModel,
        planningFingerprint: row.planningFingerprint,
        writingFingerprint: row.writingFingerprint,
        generationProfile: parseGenerationProfile(row.generationProfile),
        generatorFingerprint: row.generatorFingerprint,
        externalReviewRunId: row.externalReviewRunId,
      },
      changeProposal,
      baselineVersion,
      currentPreviewVersionId,
    };
  }

  private async getBaselineVersion(
    versionId: string,
  ): Promise<GenerationExecutionContext["baselineVersion"]> {
    const [version] = await this.db
      .select({
        id: schema.docsVersions.id,
        sourceRevision: schema.docsVersions.sourceRevision,
        sourceTreeHash: schema.docsVersions.sourceTreeHash,
        generatorFingerprint: schema.docsVersions.generatorFingerprint,
        generationStatePrefix: schema.docsVersions.generationStatePrefix,
      })
      .from(schema.docsVersions)
      .where(eq(schema.docsVersions.id, versionId))
      .limit(1);
    return version ?? null;
  }

  private async getCurrentPreviewVersionId(input: {
    projectId: string;
    siteId: string;
    provider: SourceProvider;
    changeExternalId: string;
  }): Promise<string | null> {
    const [channel] = await this.db
      .select({
        currentVersionId: schema.docsPreviewChannels.currentVersionId,
      })
      .from(schema.docsPreviewChannels)
      .where(
        and(
          eq(schema.docsPreviewChannels.projectId, input.projectId),
          eq(schema.docsPreviewChannels.siteId, input.siteId),
          eq(schema.docsPreviewChannels.provider, input.provider),
          eq(
            schema.docsPreviewChannels.changeExternalId,
            input.changeExternalId,
          ),
        ),
      )
      .limit(1);
    return channel?.currentVersionId ?? null;
  }

  async claimReviewRun(input: {
    jobId: string;
    claimToken: string;
    claimedAt: Date;
  }): Promise<ReviewRunClaim> {
    const reservation = reviewRunReservation(input.claimToken, input.claimedAt);
    const [claimed] = await this.db
      .update(schema.generationJobs)
      .set({
        externalReviewRunId: reservation,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.generationJobs.id, input.jobId),
          isNull(schema.generationJobs.externalReviewRunId),
        ),
      )
      .returning({ id: schema.generationJobs.id });

    if (claimed) return { outcome: "claimed", reconcile: false };

    const [job] = await this.db
      .select({
        externalReviewRunId: schema.generationJobs.externalReviewRunId,
      })
      .from(schema.generationJobs)
      .where(eq(schema.generationJobs.id, input.jobId))
      .limit(1);

    if (!job) return { outcome: "not_found" };
    if (job.externalReviewRunId === null) {
      return { outcome: "pending" };
    }
    const reservedAt = reviewRunReservationTime(job.externalReviewRunId);
    if (reservedAt !== null) {
      if (
        input.claimedAt.getTime() - reservedAt <
        REVIEW_RUN_RESERVATION_LEASE_MS
      ) {
        return { outcome: "pending" };
      }

      const [reclaimed] = await this.db
        .update(schema.generationJobs)
        .set({
          externalReviewRunId: reservation,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.generationJobs.id, input.jobId),
            eq(
              schema.generationJobs.externalReviewRunId,
              job.externalReviewRunId,
            ),
          ),
        )
        .returning({ id: schema.generationJobs.id });
      return reclaimed
        ? { outcome: "claimed", reconcile: true }
        : { outcome: "pending" };
    }
    return {
      outcome: "existing",
      externalRunId: job.externalReviewRunId,
    };
  }

  async completeReviewRunClaim(input: {
    jobId: string;
    claimToken: string;
    claimedAt: Date;
    externalRunId: string;
  }): Promise<boolean> {
    const [updated] = await this.db
      .update(schema.generationJobs)
      .set({
        externalReviewRunId: input.externalRunId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.generationJobs.id, input.jobId),
          eq(
            schema.generationJobs.externalReviewRunId,
            reviewRunReservation(input.claimToken, input.claimedAt),
          ),
        ),
      )
      .returning({ id: schema.generationJobs.id });

    return Boolean(updated);
  }

  async getGenerationControl(): Promise<GenerationControlDto> {
    const [control] = await this.db
      .select()
      .from(schema.platformGenerationControls)
      .where(eq(schema.platformGenerationControls.id, GLOBAL_CONTROL_ID))
      .limit(1);

    return control
      ? toGenerationControlDto(control)
      : defaultGenerationControl();
  }

  async isGenerationPaused(): Promise<boolean> {
    const control = await this.getGenerationControl();
    return control.status === "paused";
  }

  async listStaleJobs(input: {
    queuedStaleSeconds: number;
    runningStaleSeconds: number;
  }): Promise<StaleGenerationJobDto[]> {
    const jobs = await this.listJobsByStatus(
      [...ACTIVE_JOB_STATUSES],
      250,
      input,
    );
    return jobs.filter((job) => job.isStale);
  }

  async isActive(jobId: string): Promise<boolean> {
    const [job] = await this.db
      .select({ id: schema.generationJobs.id })
      .from(schema.generationJobs)
      .where(
        and(
          eq(schema.generationJobs.id, jobId),
          inArray(schema.generationJobs.status, [...ACTIVE_JOB_STATUSES]),
        ),
      )
      .limit(1);

    return Boolean(job);
  }

  async markRunning(jobId: string) {
    const updated = await this.transitionActiveJob({
      jobId,
      status: "running",
      event: { type: "running", message: "Generation started." },
    });
    if (!updated) throw new Error("Generation job is no longer active.");
  }

  /** False when the job was no longer active, so nothing changed. */
  async markFailed(jobId: string, message: string): Promise<boolean> {
    return this.transitionActiveJob({
      jobId,
      status: "failed",
      errorMessage: message,
      event: {
        type: "failed",
        message,
        data: { outcome: "failed", terminal: true },
      },
    });
  }

  async markCancelled(
    jobId: string,
    message: string,
    eventType = "admin_cancel_requested",
    data?: Record<string, unknown>,
  ): Promise<boolean> {
    return this.transitionActiveJob({
      jobId,
      status: "cancelled",
      errorMessage: message,
      event: {
        type: eventType,
        message,
        data: { ...data, outcome: "cancelled", terminal: true },
      },
    });
  }

  async addEvent(
    jobId: string,
    type: string,
    message: string,
    data?: Record<string, unknown>,
    source: JobEventSource = "api",
  ) {
    return this.db.transaction((tx) =>
      appendJobEvent(tx, {
        jobId,
        type,
        message,
        data,
        source,
      }),
    );
  }

  private async transitionActiveJob(input: {
    jobId: string;
    status: "running" | "failed" | "cancelled";
    errorMessage?: string;
    event: {
      type: string;
      message: string;
      data?: Record<string, unknown>;
      source?: JobEventSource;
    };
  }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .update(schema.generationJobs)
        .set({
          status: input.status,
          errorMessage: input.errorMessage,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.generationJobs.id, input.jobId),
            inArray(schema.generationJobs.status, [...ACTIVE_JOB_STATUSES]),
          ),
        )
        .returning({ id: schema.generationJobs.id });

      if (!job) return false;

      await appendJobEvent(tx, {
        jobId: input.jobId,
        ...input.event,
      });
      return true;
    });
  }

  private async listJobsByStatus(
    statuses: Array<
      "queued" | "running" | "succeeded" | "failed" | "cancelled"
    >,
    limit: number,
    thresholds: { queuedStaleSeconds: number; runningStaleSeconds: number },
  ): Promise<StaleGenerationJobDto[]> {
    const rows = await this.db
      .select({
        job: schema.generationJobs,
        projectName: schema.projects.name,
        projectSlug: schema.projects.slug,
        repositoryFullName: schema.githubRepositories.fullName,
      })
      .from(schema.generationJobs)
      .innerJoin(
        schema.projects,
        eq(schema.generationJobs.projectId, schema.projects.id),
      )
      .leftJoin(
        schema.githubRepositories,
        eq(schema.projects.githubRepositoryId, schema.githubRepositories.id),
      )
      .where(inArray(schema.generationJobs.status, statuses))
      .orderBy(desc(schema.generationJobs.createdAt))
      .limit(limit);

    const latestEvents = await this.latestEventsForJobs(
      rows.map((row) => row.job.id),
    );
    const now = new Date();
    return rows.map((row) =>
      toStaleGenerationJobDto(
        row,
        latestEvents.get(row.job.id) ?? null,
        thresholds,
        now,
      ),
    );
  }

  private async latestEventsForJobs(
    jobIds: string[],
  ): Promise<Map<string, JobEventDto>> {
    if (jobIds.length === 0) return new Map();

    const rows = await this.db
      .select()
      .from(schema.jobEvents)
      .where(inArray(schema.jobEvents.jobId, jobIds))
      .orderBy(
        desc(schema.jobEvents.sequence),
        desc(schema.jobEvents.createdAt),
      );

    const latest = new Map<string, JobEventDto>();
    for (const row of rows) {
      if (!latest.has(row.jobId)) {
        latest.set(row.jobId, toJobEventDto(row));
      }
    }

    return latest;
  }
}

type JobsTransaction = Parameters<Parameters<DoxaDb["transaction"]>[0]>[0];

interface LockedGenerationContext {
  job: typeof schema.generationJobs.$inferSelect;
  site: typeof schema.docsSites.$inferSelect | null;
  sourceVersion: typeof schema.docsVersions.$inferSelect | null;
  publishedVersion: {
    id: string;
    baselineVersionId: string | null;
    artifactPrefix: string;
  } | null;
  review: GenerationRunReview | null;
}

async function getLockedGenerationContext(
  transaction: JobsTransaction,
  input: {
    userId: string;
    projectId: string;
    jobId: string;
  },
): Promise<LockedGenerationContext | null> {
  const [owned] = await transaction
    .select({ job: schema.generationJobs })
    .from(schema.generationJobs)
    .innerJoin(
      schema.projects,
      eq(schema.generationJobs.projectId, schema.projects.id),
    )
    .where(
      and(
        eq(schema.projects.userId, input.userId),
        eq(schema.generationJobs.projectId, input.projectId),
        eq(schema.generationJobs.id, input.jobId),
      ),
    )
    .for("update")
    .limit(1);
  if (!owned) return null;

  const [site] = await transaction
    .select()
    .from(schema.docsSites)
    .where(eq(schema.docsSites.projectId, input.projectId))
    .for("update")
    .limit(1);
  const [sourceVersion] = owned.job.docsVersionId
    ? await transaction
        .select()
        .from(schema.docsVersions)
        .where(eq(schema.docsVersions.id, owned.job.docsVersionId))
        .limit(1)
    : [];
  const [publishedVersion] = site?.publishedVersionId
    ? await transaction
        .select({
          id: schema.docsVersions.id,
          baselineVersionId: schema.docsVersions.baselineVersionId,
          artifactPrefix: schema.docsVersions.artifactPrefix,
        })
        .from(schema.docsVersions)
        .where(eq(schema.docsVersions.id, site.publishedVersionId))
        .limit(1)
    : [];
  const [review] = await transaction
    .select({
      status: schema.generationReviews.status,
      publishedVersionId: schema.generationReviews.publishedVersionId,
    })
    .from(schema.generationReviews)
    .where(eq(schema.generationReviews.jobId, owned.job.id))
    .limit(1);

  return {
    job: owned.job,
    site: site ?? null,
    sourceVersion: sourceVersion ?? null,
    publishedVersion: publishedVersion ?? null,
    review: review ?? null,
  };
}

async function linkDoxabotDelivery(
  database: JobsTransaction,
  input: {
    provider: SourceProvider;
    deliveryId: string;
    jobId: string;
    queuePublishedAt: Date | null;
  },
): Promise<void> {
  const [linked] = await database
    .update(schema.scmWebhookDeliveries)
    .set({
      generationJobId: input.jobId,
      queuePublishedAt: input.queuePublishedAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.scmWebhookDeliveries.provider, input.provider),
        eq(schema.scmWebhookDeliveries.deliveryId, input.deliveryId),
        or(
          isNull(schema.scmWebhookDeliveries.generationJobId),
          eq(schema.scmWebhookDeliveries.generationJobId, input.jobId),
        ),
      ),
    )
    .returning({ id: schema.scmWebhookDeliveries.id });

  if (!linked) {
    throw new Error(
      "Webhook delivery could not be atomically linked to its job.",
    );
  }
}

function doxabotJobValues(
  input: CreateDoxabotGenerationJobInput,
  requestedByUserId: string | null,
): typeof schema.generationJobs.$inferInsert {
  return {
    projectId: input.projectId,
    requestedByUserId,
    trigger: "doxabot",
    publicationMode: "preview",
    sourceProvider: input.provider,
    sourceInstallationExternalId: input.sourceInstallationExternalId,
    sourceAuthorExternalId: input.sourceAuthor?.externalId ?? null,
    sourceAuthorHandle: input.sourceAuthor?.handle ?? null,
    sourceAuthorAvatarUrl: input.sourceAuthor?.avatarUrl ?? null,
    changeProposalId: input.changeProposalId,
    changeExternalId: input.changeExternalId,
    baselineRevision: input.baselineRevision,
    targetRevision: input.targetRevision,
    sourceTreeHash: input.sourceTreeHash,
    baselineVersionId: input.baselineVersionId,
    agentModel: input.writerModel,
    plannerModel: input.plannerModel,
    writerModel: input.writerModel,
    planningFingerprint: input.planningFingerprint,
    writingFingerprint: input.writingFingerprint,
    generationProfile: input.generationProfile,
    generatorFingerprint: input.generatorFingerprint,
    idempotencyKey: input.idempotencyKey,
    concurrencyKey: input.concurrencyKey,
  };
}

async function findSourceAuthorUserId(
  transaction: JobsTransaction,
  input: Pick<CreateDoxabotGenerationJobInput, "provider" | "sourceAuthor">,
): Promise<string | null> {
  if (!input.sourceAuthor) return null;

  const [account] = await transaction
    .select({ userId: schema.account.userId })
    .from(schema.account)
    .where(
      and(
        eq(schema.account.providerId, input.provider),
        eq(schema.account.accountId, input.sourceAuthor.externalId),
      ),
    )
    .limit(1);

  return account?.userId ?? null;
}

function toJobDto(
  job: typeof schema.generationJobs.$inferSelect,
): GenerationJobDto {
  return {
    id: job.id,
    projectId: job.projectId,
    status: job.status,
    docsVersionId: job.docsVersionId,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

function parseGenerationProfile(
  value: string | null,
): GenerationProfile | null {
  return value === "fast-mvp" || value === "full-prod" ? value : null;
}

function toGenerationControlDto(
  control: typeof schema.platformGenerationControls.$inferSelect,
): GenerationControlDto {
  return {
    status: control.status,
    reason: control.reason,
    updatedByUserId: control.updatedByUserId,
    updatedAt: control.updatedAt.toISOString(),
  };
}

function defaultGenerationControl(): GenerationControlDto {
  return {
    status: "enabled",
    reason: null,
    updatedByUserId: null,
    updatedAt: null,
  };
}

function toStaleGenerationJobDto(
  row: {
    job: typeof schema.generationJobs.$inferSelect;
    projectName: string;
    projectSlug: string;
    repositoryFullName: string | null;
  },
  latestEvent: JobEventDto | null,
  thresholds: { queuedStaleSeconds: number; runningStaleSeconds: number },
  now: Date,
): StaleGenerationJobDto {
  const job = toJobDto(row.job);
  const elapsedSeconds = secondsBetween(now, row.job.createdAt);
  const staleReference =
    row.job.status === "queued" ? row.job.createdAt : row.job.updatedAt;
  const staleThreshold =
    row.job.status === "queued"
      ? thresholds.queuedStaleSeconds
      : thresholds.runningStaleSeconds;
  const isStale =
    (row.job.status === "queued" || row.job.status === "running") &&
    secondsBetween(now, staleReference) >= staleThreshold;

  return {
    ...job,
    projectName: row.projectName,
    projectSlug: row.projectSlug,
    repositoryFullName: row.repositoryFullName,
    latestEvent,
    elapsedSeconds,
    isStale,
  };
}

function secondsBetween(later: Date, earlier: Date): number {
  return Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / 1000));
}

const REVIEW_RUN_RESERVATION_PREFIX = "pending";
const REVIEW_RUN_RESERVATION_LEASE_MS = 5 * 60 * 1_000;

function reviewRunReservation(claimToken: string, claimedAt: Date): string {
  return [REVIEW_RUN_RESERVATION_PREFIX, claimedAt.getTime(), claimToken].join(
    ":",
  );
}

function reviewRunReservationTime(value: string): number | null {
  if (!value.startsWith(`${REVIEW_RUN_RESERVATION_PREFIX}:`)) return null;
  const [, timestamp] = value.split(":");
  const parsed = Number(timestamp);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
