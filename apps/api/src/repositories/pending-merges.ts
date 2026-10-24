import { and, desc, eq, isNull, lte, max, ne } from "drizzle-orm";
import { createDb, schema, type DbEnv, type DoxaDb } from "@doxahq/db";
import type {
  DoxabotBatchQuietMinutes,
  DoxabotMergeTrigger,
  PendingMerges,
} from "@doxahq/contracts";
import { toBatchQuietMinutes } from "./doxabot-settings";

/** A project with merges that the scheduler has not tried to generate. */
export interface MergeCandidate {
  projectId: string;
  ownerUserId: string;
  mergeTrigger: Exclude<DoxabotMergeTrigger, "manual">;
  batchQuietMinutes: DoxabotBatchQuietMinutes;
  lastMergedAt: Date;
}

export interface PendingMergesStore {
  record(input: {
    projectId: string;
    changeExternalId: string;
    changeNumber: number;
    mergedAt: Date;
  }): Promise<void>;
  listForProject(projectId: string): Promise<PendingMerges["merges"]>;
  /** Projects whose Doxabot runs after merges and has untried merges. */
  candidates(): Promise<MergeCandidate[]>;
  /** Marks the untried merges of a project, up to `until`, as tried. */
  markAttempted(input: { projectId: string; until: Date }): Promise<void>;
  /** Removes the merges that a production run of the job covers. */
  clearCoveredByJob(jobId: string): Promise<void>;
}

export class PendingMergesRepository implements PendingMergesStore {
  private readonly db: DoxaDb;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  async record(input: {
    projectId: string;
    changeExternalId: string;
    changeNumber: number;
    mergedAt: Date;
  }): Promise<void> {
    await this.db
      .insert(schema.generationPendingMerges)
      .values(input)
      .onConflictDoNothing();
  }

  async listForProject(projectId: string): Promise<PendingMerges["merges"]> {
    const rows = await this.db
      .select({
        number: schema.generationPendingMerges.changeNumber,
        mergedAt: schema.generationPendingMerges.mergedAt,
      })
      .from(schema.generationPendingMerges)
      .where(eq(schema.generationPendingMerges.projectId, projectId))
      .orderBy(desc(schema.generationPendingMerges.mergedAt));

    return rows.map((row) => ({
      number: row.number,
      mergedAt: row.mergedAt.toISOString(),
    }));
  }

  async candidates(): Promise<MergeCandidate[]> {
    const merges = schema.generationPendingMerges;
    const settings = schema.doxabotAutomationSettings;
    const rows = await this.db
      .select({
        projectId: merges.projectId,
        ownerUserId: schema.projects.userId,
        mergeTrigger: settings.mergeTrigger,
        batchQuietMinutes: settings.batchQuietMinutes,
        lastMergedAt: max(merges.mergedAt),
      })
      .from(merges)
      .innerJoin(schema.projects, eq(schema.projects.id, merges.projectId))
      .innerJoin(settings, eq(settings.projectId, merges.projectId))
      .where(
        and(
          isNull(merges.attemptedAt),
          eq(settings.enabled, true),
          ne(settings.mergeTrigger, "manual"),
        ),
      )
      .groupBy(
        merges.projectId,
        schema.projects.userId,
        settings.mergeTrigger,
        settings.batchQuietMinutes,
      );

    return rows.flatMap((row): MergeCandidate[] =>
      row.lastMergedAt && row.mergeTrigger !== "manual"
        ? [
            {
              projectId: row.projectId,
              ownerUserId: row.ownerUserId,
              mergeTrigger: row.mergeTrigger,
              batchQuietMinutes: toBatchQuietMinutes(row.batchQuietMinutes),
              lastMergedAt: row.lastMergedAt,
            },
          ]
        : [],
    );
  }

  async markAttempted(input: { projectId: string; until: Date }): Promise<void> {
    await this.db
      .update(schema.generationPendingMerges)
      .set({ attemptedAt: input.until })
      .where(
        and(
          eq(schema.generationPendingMerges.projectId, input.projectId),
          isNull(schema.generationPendingMerges.attemptedAt),
          lte(schema.generationPendingMerges.mergedAt, input.until),
        ),
      );
  }

  async clearCoveredByJob(jobId: string): Promise<void> {
    const [job] = await this.db
      .select({
        projectId: schema.generationJobs.projectId,
        createdAt: schema.generationJobs.createdAt,
      })
      .from(schema.generationJobs)
      .where(eq(schema.generationJobs.id, jobId))
      .limit(1);
    if (!job) return;

    // A run checks out the default branch when it starts, so it covers every
    // merge before that moment.
    await this.db
      .delete(schema.generationPendingMerges)
      .where(
        and(
          eq(schema.generationPendingMerges.projectId, job.projectId),
          lte(schema.generationPendingMerges.mergedAt, job.createdAt),
        ),
      );
  }
}
