import { createDb, schema, type DbEnv, type DoxaDb } from "@doxahq/db";
import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm";
import type {
  DailyModelCostPort,
  MeteringJobFacts,
  MeteringJobsPort,
} from "../services/billing/generation-metering";
import { appendJobEvent } from "./job-events";
import { GENERATION_CREDITS_EVENT_TYPE, type GenerationCreditsEventData } from "@doxahq/contracts/billing";

const { generationJobs, jobEvents, generationUsageRecords, projects, creditAccruals } = schema;

/** At most this many missed accruals in one read; the settle reads again until none is left. */
const UNACCRUED_USAGE_LIMIT = 5_000;

/**
 * The job reads of the credit meter (billing spec 10.5) and the daily model
 * cost of an account (spec 19), from the generation tables.
 */
export class BillingMeteringRepository implements MeteringJobsPort, DailyModelCostPort {
  private readonly db: DoxaDb;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  async getFacts(jobId: string): Promise<MeteringJobFacts | null> {
    const [job] = await this.db
      .select({
        projectId: generationJobs.projectId,
        status: generationJobs.status,
        publicationMode: generationJobs.publicationMode,
        trigger: generationJobs.trigger,
        baselineVersionId: generationJobs.baselineVersionId,
      })
      .from(generationJobs)
      .where(eq(generationJobs.id, jobId))
      .limit(1);
    if (!job) return null;
    const [event] = await this.db
      .select({ type: jobEvents.type, data: jobEvents.data })
      .from(jobEvents)
      .where(and(eq(jobEvents.jobId, jobId), sql`${jobEvents.data}->>'terminal' = 'true'`))
      .orderBy(desc(jobEvents.sequence))
      .limit(1);
    return { ...job, terminalEvent: event ? { type: event.type, data: event.data ?? null } : null };
  }

  async usageCostUsd(jobId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ costUsd: sql<string | null>`sum(${generationUsageRecords.costUsd})` })
      .from(generationUsageRecords)
      .where(eq(generationUsageRecords.jobId, jobId));
    return row?.costUsd ?? null;
  }

  async unaccruedUsage(jobId: string, since: Date): Promise<{ callId: string; costUsd: string | null }[]> {
    return this.db
      .select({ callId: sql<string>`${generationUsageRecords.callId}::text`, costUsd: generationUsageRecords.costUsd })
      .from(generationUsageRecords)
      .leftJoin(creditAccruals, sql`${creditAccruals.callId} = ${generationUsageRecords.callId}::text`)
      .where(and(eq(generationUsageRecords.jobId, jobId), gte(generationUsageRecords.createdAt, since), isNull(creditAccruals.callId)))
      .orderBy(asc(generationUsageRecords.createdAt))
      .limit(UNACCRUED_USAGE_LIMIT);
  }

  async recentJobIds(projectId: string, limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ id: generationJobs.id })
      .from(generationJobs)
      .where(eq(generationJobs.projectId, projectId))
      .orderBy(desc(generationJobs.createdAt))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  async addCreditsEvent(jobId: string, data: GenerationCreditsEventData): Promise<void> {
    await this.db.transaction((tx) =>
      appendJobEvent(tx, {
        jobId,
        type: GENERATION_CREDITS_EVENT_TYPE,
        message: `${data.jobUsedCredits ?? data.usedCredits} credits so far.`,
        data: { ...data },
        source: "api",
      }),
    );
  }

  /**
   * Model cost of an account's projects since `since`. A team account holds
   * the team's projects; a personal account holds the user's projects that
   * have no team (billing spec 8.1). Spend rows keep their project after a
   * generation is deleted, so a deleted run still counts.
   */
  async modelCostUsdSince(input: { ownerKind: "user" | "team"; ownerId: string; since: Date }): Promise<string | null> {
    const owner =
      input.ownerKind === "team"
        ? eq(projects.teamId, input.ownerId)
        : and(eq(projects.userId, input.ownerId), isNull(projects.teamId));
    const [row] = await this.db
      .select({ costUsd: sql<string | null>`sum(${generationUsageRecords.costUsd})` })
      .from(generationUsageRecords)
      .innerJoin(projects, eq(projects.id, generationUsageRecords.projectId))
      .where(and(owner, gte(generationUsageRecords.recordedAt, input.since)));
    return row?.costUsd ?? null;
  }
}
