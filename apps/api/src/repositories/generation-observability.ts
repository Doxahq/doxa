import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { createDb, schema, type DoxaDb } from "@doxahq/db";
import type {
  GenerationDatabaseCompatibility,
  GenerationProjectUsageTotals,
  GenerationRepairDiagnostic,
  GenerationUsageRecord,
  GenerationUsageSummary,
} from "@doxahq/contracts";
import type { Env } from "../env";

/**
 * Repair diagnostics expire. Usage rows have no retention: they are kept
 * until billing decides how long spend history stays.
 */
export const DIAGNOSTIC_RETENTION_DAYS = 30;
const COST_SCALE = 12;
const REQUIRED_DIAGNOSTIC_COLUMNS = [
  "max_attempts",
  "rejection_reason",
  "validation_issue_codes",
  "writer_attempt",
] as const;

export interface GenerationDiagnosticMetadata {
  diagnosticId: string;
  jobId: string;
  stageExecutionId: string;
  pageId: string;
  pageTitle: string;
  pageRetry: number;
  writerAttempt: number;
  attempt: number;
  maxAttempts: number;
  model: string;
  rule: string;
  message: string;
  line: number | null;
  column: number | null;
  snippet: string | null;
  draftKey: string;
  draftSha256: string;
  draftTruncated: boolean;
  repairKind: GenerationRepairDiagnostic["repairKind"];
  repairSucceeded: boolean;
  rejectionReason: string | null;
  validationIssueCodes: string[];
  recordedAt: Date;
  expiresAt: Date;
}

export function toGenerationDiagnosticMetadata(
  diagnostic: GenerationRepairDiagnostic,
  draftKey: string,
): GenerationDiagnosticMetadata {
  const recordedAt = new Date(diagnostic.createdAt);
  return {
    diagnosticId: diagnostic.diagnosticId,
    jobId: diagnostic.jobId,
    stageExecutionId: diagnostic.stageExecutionId,
    pageId: diagnostic.pageId,
    pageTitle: diagnostic.pageTitle,
    pageRetry: diagnostic.pageRetry,
    writerAttempt: diagnostic.writerAttempt,
    attempt: diagnostic.attempt,
    maxAttempts: diagnostic.maxAttempts,
    model: diagnostic.model,
    rule: diagnostic.rule,
    message: diagnostic.message,
    line: diagnostic.line,
    column: diagnostic.column,
    snippet: diagnostic.snippet,
    draftKey,
    draftSha256: diagnostic.draftSha256,
    draftTruncated: diagnostic.draftTruncated,
    repairKind: diagnostic.repairKind,
    repairSucceeded: diagnostic.repairSucceeded,
    rejectionReason: diagnostic.rejectionReason,
    validationIssueCodes: diagnostic.validationIssueCodes,
    recordedAt,
    expiresAt: addDays(recordedAt, DIAGNOSTIC_RETENTION_DAYS),
  };
}

export function evaluateGenerationObservabilitySchema(
  columnNames: readonly string[],
): GenerationDatabaseCompatibility {
  const availableColumns = new Set(columnNames);
  const missingColumns = REQUIRED_DIAGNOSTIC_COLUMNS.filter(
    (columnName) => !availableColumns.has(columnName),
  );
  return {
    ready: missingColumns.length === 0,
    missingColumns: [...missingColumns],
  };
}

export function summarizeGenerationUsage(
  records: readonly GenerationUsageRecord[],
): GenerationUsageSummary {
  const first = records[0];
  if (!first) {
    throw new Error("Cannot summarize an empty generation usage collection.");
  }
  let cost = 0n;
  let hasCost = false;
  let missingCostCount = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;

  for (const record of records) {
    if (record.jobId !== first.jobId) {
      throw new Error("Generation usage summary cannot span multiple jobs.");
    }
    promptTokens += record.promptTokens;
    completionTokens += record.completionTokens;
    totalTokens += record.totalTokens;
    cachedTokens += record.cachedTokens ?? 0;
    cacheWriteTokens += record.cacheWriteTokens ?? 0;
    reasoningTokens += record.reasoningTokens ?? 0;
    if (record.costUsd === null) {
      missingCostCount += 1;
    } else {
      hasCost = true;
      cost += parseDecimal(record.costUsd);
    }
  }

  return {
    jobId: first.jobId,
    requestCount: records.length,
    missingCostCount,
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    cacheWriteTokens,
    reasoningTokens,
    costUsd: hasCost ? formatDecimal(cost) : null,
  };
}

export class GenerationObservabilityRepository {
  private readonly db: DoxaDb;

  constructor(env: Pick<Env, "DATABASE_URL">) {
    this.db = createDb(env);
  }

  async recordUsage(record: GenerationUsageRecord): Promise<void> {
    await this.db
      .insert(schema.generationUsageRecords)
      .values({
        ...toGenerationUsageRow(record),
        // Attribution comes from the generation, and the producer of the record
        // does not know it. A correlated subquery resolves it inside the insert,
        // so the write path keeps one round trip. The foreign key on `job_id`
        // guarantees that the generation exists, so this never resolves to null.
        projectId: sql<string>`(
          select ${schema.generationJobs.projectId}
          from ${schema.generationJobs}
          where ${schema.generationJobs.id} = ${record.jobId}
        )`,
      })
      .onConflictDoNothing({
        target: schema.generationUsageRecords.callId,
      });
  }

  /** Total spend for one project, for budgeting. It includes deleted generations. */
  async getProjectUsageTotals(input: {
    projectId: string;
    since?: Date;
  }): Promise<GenerationProjectUsageTotals> {
    const [row] = await this.db
      .select({
        requestCount: sql<number>`count(*)::int`,
        totalTokens: sql<number>`coalesce(sum(${schema.generationUsageRecords.totalTokens}), 0)::int`,
        costUsd: sql<string | null>`sum(${schema.generationUsageRecords.costUsd})`,
      })
      .from(schema.generationUsageRecords)
      .where(
        and(
          eq(schema.generationUsageRecords.projectId, input.projectId),
          input.since
            ? gte(schema.generationUsageRecords.recordedAt, input.since)
            : undefined,
        ),
      );

    return {
      projectId: input.projectId,
      requestCount: row?.requestCount ?? 0,
      totalTokens: row?.totalTokens ?? 0,
      costUsd: row?.costUsd ?? null,
    };
  }

  async getDatabaseCompatibility(): Promise<GenerationDatabaseCompatibility> {
    const result = await this.db.execute<{ column_name: string }>(sql`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'generation_repair_diagnostics'
    `);
    return evaluateGenerationObservabilitySchema(
      result.rows.map((row) => row.column_name),
    );
  }

  async recordDiagnostic(metadata: GenerationDiagnosticMetadata): Promise<void> {
    await this.db
      .insert(schema.generationRepairDiagnostics)
      .values(metadata)
      .onConflictDoNothing({
        target: schema.generationRepairDiagnostics.diagnosticId,
      });
  }

  async getUsageSummary(jobId: string): Promise<GenerationUsageSummary | null> {
    const rows = await this.db
      .select()
      .from(schema.generationUsageRecords)
      .where(eq(schema.generationUsageRecords.jobId, jobId));
    if (rows.length === 0) return null;
    return summarizeGenerationUsage(rows.map((row) => toUsageRecord(row, jobId)));
  }

  /** Deletes expired repair diagnostics. Usage rows are never deleted. */
  async deleteExpired(now: Date, limit = 500): Promise<{
    diagnostics: number;
  }> {
    const rows = await this.db
      .select({ id: schema.generationRepairDiagnostics.id })
      .from(schema.generationRepairDiagnostics)
      .where(lt(schema.generationRepairDiagnostics.expiresAt, now))
      .limit(limit);
    const ids = rows.map((row) => row.id);
    if (ids.length > 0) {
      await this.db.delete(schema.generationRepairDiagnostics).where(
        inArray(schema.generationRepairDiagnostics.id, ids),
      );
    }
    return { diagnostics: ids.length };
  }
}

/**
 * The stored columns of one usage record, apart from its project. The row has
 * no expiry: usage rows are kept for billing.
 */
export function toGenerationUsageRow(record: GenerationUsageRecord) {
  return { ...record, recordedAt: new Date(record.recordedAt) };
}

/**
 * `row.jobId` is nullable, because a deleted generation clears it. The caller
 * queries by one job id, so it passes that id in rather than widening the DTO.
 */
function toUsageRecord(
  row: typeof schema.generationUsageRecords.$inferSelect,
  jobId: string,
): GenerationUsageRecord {
  return {
    callId: row.callId,
    jobId,
    stageExecutionId: row.stageExecutionId,
    stage: row.stage as GenerationUsageRecord["stage"],
    operation: row.operation as GenerationUsageRecord["operation"],
    modelRole: row.modelRole as GenerationUsageRecord["modelRole"],
    model: row.model,
    pageId: row.pageId,
    pageTitle: row.pageTitle,
    pageRetry: row.pageRetry,
    attempt: row.attempt,
    iteration: row.iteration,
    providerGenerationId: row.providerGenerationId,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    totalTokens: row.totalTokens,
    cachedTokens: row.cachedTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    reasoningTokens: row.reasoningTokens,
    costUsd: row.costUsd,
    promptCostUsd: row.promptCostUsd,
    completionCostUsd: row.completionCostUsd,
    upstreamCostUsd: row.upstreamCostUsd,
    durationMs: row.durationMs,
    finishReason: row.finishReason,
    recordedAt: row.recordedAt.toISOString(),
  };
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1_000);
}

function parseDecimal(value: string): bigint {
  const [whole, fractional = ""] = value.split(".");
  return BigInt(`${whole}${fractional.padEnd(COST_SCALE, "0").slice(0, COST_SCALE)}`);
}

function formatDecimal(value: bigint): string {
  const raw = value.toString().padStart(COST_SCALE + 1, "0");
  return `${raw.slice(0, -COST_SCALE)}.${raw.slice(-COST_SCALE)}`;
}
