import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { createDb, schema, type DbEnv } from "@doxahq/db";
import {
  AGENT_ACTION_KINDS,
  type AgentActionKind,
} from "@doxahq/contracts/approval-requests";

/** How many rows each source gives to the activity feed. */
const ACTIVITY_SOURCE_LIMIT = 20;

/** The open pull requests that the Overview lists. */
const OPEN_PREVIEW_LIMIT = 5;

/**
 * A publish or a restore also writes a publication, which the feed already
 * shows. A domain check changes nothing.
 */
const NOT_IN_ACTIVITY: ReadonlySet<AgentActionKind> = new Set([
  "docs.publish",
  "docs.restore",
  "domain.check",
]);

const ACTIVITY_AGENT_ACTIONS = AGENT_ACTION_KINDS.filter(
  (kind) => !NOT_IN_ACTIVITY.has(kind),
);

export interface PublicationRow {
  id: string;
  kind: (typeof schema.docsPublicationKind.enumValues)[number];
  versionNumber: number;
  createdAt: Date;
  summary: unknown;
  actorName: string | null;
  agentClientName: string | null;
}

export interface FinishedJobRow {
  id: string;
  status: (typeof schema.generationJobStatus.enumValues)[number];
  publicationMode: (typeof schema.generationPublicationMode.enumValues)[number];
  versionStatus: (typeof schema.docsVersionStatus.enumValues)[number] | null;
  pullRequestNumber: number | null;
  updatedAt: Date;
}

export interface AgentActionRow {
  id: string;
  clientName: string;
  actionKind: string | null;
  occurredAt: Date;
}

export interface OpenPreviewRow {
  pullRequestNumber: number;
  status: (typeof schema.generationJobStatus.enumValues)[number];
  hostname: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectOverviewRows {
  publications: PublicationRow[];
  finishedJobs: FinishedJobRow[];
  /** Who cancelled, by generation. A run that Doxa stopped has no entry. */
  cancelledBy: ReadonlyMap<string, string>;
  agentActions: AgentActionRow[];
  openPreviews: OpenPreviewRow[];
  lastSyncedRevision: string | null;
}

export class ProjectOverviewRepository {
  private readonly db;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  async read(projectId: string): Promise<ProjectOverviewRows> {
    const [publications, finishedJobs, agentActions, openPreviews, lastSyncedRevision] =
      await Promise.all([
        this.publications(projectId),
        this.finishedJobs(projectId),
        this.agentActions(projectId),
        this.openPreviews(projectId),
        this.lastSyncedRevision(projectId),
      ]);
    const cancelledBy = await this.cancelledBy(
      finishedJobs.filter((job) => job.status === "cancelled").map((job) => job.id),
    );
    return {
      publications,
      finishedJobs,
      cancelledBy,
      agentActions,
      openPreviews,
      lastSyncedRevision,
    };
  }

  private publications(projectId: string): Promise<PublicationRow[]> {
    return this.db
      .select({
        id: schema.docsPublications.id,
        kind: schema.docsPublications.kind,
        versionNumber: schema.docsVersions.versionNumber,
        createdAt: schema.docsPublications.createdAt,
        summary: schema.docsPublications.summary,
        actorName: schema.user.name,
        agentClientName: schema.docsPublications.agentClientName,
      })
      .from(schema.docsPublications)
      .innerJoin(
        schema.docsSites,
        eq(schema.docsSites.id, schema.docsPublications.siteId),
      )
      .innerJoin(
        schema.docsVersions,
        eq(schema.docsVersions.id, schema.docsPublications.versionId),
      )
      .leftJoin(
        schema.user,
        eq(schema.user.id, schema.docsPublications.actorUserId),
      )
      .where(eq(schema.docsSites.projectId, projectId))
      .orderBy(
        desc(schema.docsPublications.createdAt),
        desc(schema.docsPublications.id),
      )
      .limit(ACTIVITY_SOURCE_LIMIT);
  }

  private finishedJobs(projectId: string): Promise<FinishedJobRow[]> {
    return this.db
      .select({
        id: schema.generationJobs.id,
        status: schema.generationJobs.status,
        publicationMode: schema.generationJobs.publicationMode,
        versionStatus: schema.docsVersions.status,
        pullRequestNumber: schema.scmChangeProposals.displayNumber,
        updatedAt: schema.generationJobs.updatedAt,
      })
      .from(schema.generationJobs)
      .leftJoin(
        schema.docsVersions,
        eq(schema.docsVersions.id, schema.generationJobs.docsVersionId),
      )
      .leftJoin(
        schema.scmChangeProposals,
        eq(schema.scmChangeProposals.id, schema.generationJobs.changeProposalId),
      )
      .where(
        and(
          eq(schema.generationJobs.projectId, projectId),
          inArray(schema.generationJobs.status, [
            "succeeded",
            "failed",
            "cancelled",
          ]),
        ),
      )
      .orderBy(desc(schema.generationJobs.updatedAt))
      .limit(ACTIVITY_SOURCE_LIMIT);
  }

  private async cancelledBy(
    jobIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (jobIds.length === 0) return new Map();
    const rows = await this.db
      .select({ jobId: schema.jobEvents.jobId, name: schema.user.name })
      .from(schema.jobEvents)
      .innerJoin(
        schema.user,
        eq(schema.user.id, sql`${schema.jobEvents.data} ->> 'requestedByUserId'`),
      )
      .where(
        and(
          inArray(schema.jobEvents.jobId, [...jobIds]),
          sql`${schema.jobEvents.data} ->> 'outcome' = 'cancelled'`,
        ),
      );
    return new Map(rows.map((row) => [row.jobId, row.name]));
  }

  private agentActions(projectId: string): Promise<AgentActionRow[]> {
    return this.db
      .select({
        id: schema.agentActivity.id,
        clientName: schema.agentActivity.clientName,
        actionKind: schema.agentActivity.actionKind,
        occurredAt: schema.agentActivity.occurredAt,
      })
      .from(schema.agentActivity)
      .where(
        and(
          eq(schema.agentActivity.projectId, projectId),
          eq(schema.agentActivity.outcome, "succeeded"),
          inArray(schema.agentActivity.actionKind, ACTIVITY_AGENT_ACTIONS),
        ),
      )
      .orderBy(desc(schema.agentActivity.occurredAt))
      .limit(ACTIVITY_SOURCE_LIMIT);
  }

  /** One row per open pull request: its newest Doxabot preview run. */
  private async openPreviews(projectId: string): Promise<OpenPreviewRow[]> {
    const rows = await this.db
      .selectDistinctOn([schema.generationJobs.changeProposalId], {
        pullRequestNumber: schema.scmChangeProposals.displayNumber,
        status: schema.generationJobs.status,
        hostname: schema.docsPreviewChannels.hostname,
        createdAt: schema.generationJobs.createdAt,
        updatedAt: schema.generationJobs.updatedAt,
      })
      .from(schema.generationJobs)
      .innerJoin(
        schema.scmChangeProposals,
        and(
          eq(schema.scmChangeProposals.id, schema.generationJobs.changeProposalId),
          eq(schema.scmChangeProposals.state, "open"),
        ),
      )
      .leftJoin(
        schema.docsPreviewChannels,
        and(
          eq(schema.docsPreviewChannels.projectId, schema.scmChangeProposals.projectId),
          eq(schema.docsPreviewChannels.provider, schema.scmChangeProposals.provider),
          eq(
            schema.docsPreviewChannels.changeExternalId,
            schema.scmChangeProposals.externalId,
          ),
          eq(schema.docsPreviewChannels.lifecycleState, "active"),
          isNotNull(schema.docsPreviewChannels.currentVersionId),
        ),
      )
      .where(
        and(
          eq(schema.generationJobs.projectId, projectId),
          eq(schema.generationJobs.publicationMode, "preview"),
        ),
      )
      .orderBy(
        schema.generationJobs.changeProposalId,
        desc(schema.generationJobs.createdAt),
      );

    return rows
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, OPEN_PREVIEW_LIMIT);
  }

  private async lastSyncedRevision(projectId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ revision: schema.generationJobs.targetRevision })
      .from(schema.generationJobs)
      .innerJoin(
        schema.docsPublications,
        eq(schema.docsPublications.versionId, schema.generationJobs.docsVersionId),
      )
      .where(
        and(
          eq(schema.generationJobs.projectId, projectId),
          eq(schema.generationJobs.publicationMode, "production"),
          isNotNull(schema.generationJobs.targetRevision),
        ),
      )
      .orderBy(desc(schema.docsPublications.createdAt))
      .limit(1);
    return row?.revision ?? null;
  }
}
