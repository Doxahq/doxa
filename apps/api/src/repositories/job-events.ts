import { eq, sql } from "drizzle-orm";
import { schema, type DoxaDb } from "@doxahq/db";
import {
  referenceSourceReportSchema,
  type JobEventDto,
  type JobEventSource,
  type ReferenceSourceReport,
} from "@doxahq/contracts";
import {
  flaggedPageSchema,
  type FlaggedPage,
} from "@doxahq/contracts/generation-reviews";

type JobEventTransaction = Parameters<Parameters<DoxaDb["transaction"]>[0]>[0];
export type JobEventDatabase = DoxaDb | JobEventTransaction;

/**
 * The events that link a failed run and the run that started it again.
 * Each one keeps the other run's id in `data.jobId`.
 */
export const RERUN_EVENT_TYPES = {
  /** On the failed run. It points to the new run. */
  started: "rerun_started",
  /** On the new run. It points to the failed run. */
  of: "rerun_of",
} as const;

/**
 * The flagged pages of a run from its `generation_page_flagged` events, in
 * event order. A page flagged twice, by a retried step, keeps its last flag;
 * an event with unreadable data is left out.
 */
export function flaggedPagesFromEvents(
  events: readonly { data: unknown }[],
): FlaggedPage[] {
  const byPageId = new Map<string, FlaggedPage>();
  for (const event of events) {
    const parsed = flaggedPageSchema.safeParse(event.data);
    if (parsed.success) byPageId.set(parsed.data.pageId, parsed.data);
  }
  return [...byPageId.values()];
}

/** The event of the analysis stage. Its `data.referenceSource` holds the REST reference report. */
export const ANALYSIS_COMPLETE_EVENT_TYPE = "analysis_complete";

/**
 * The REST reference report of a run, from its last analysis event that
 * carries a readable one. A retried analysis step reports again, and the
 * last report is the one the run used.
 */
export function referenceSourceFromEvents(
  events: readonly { data: unknown }[],
): ReferenceSourceReport | null {
  for (const event of [...events].reverse()) {
    const data = event.data;
    if (!data || typeof data !== "object" || !("referenceSource" in data)) continue;
    const parsed = referenceSourceReportSchema.safeParse(data.referenceSource);
    if (parsed.success) return parsed.data;
  }
  return null;
}

export interface AppendJobEventInput {
  jobId: string;
  type: string;
  message: string;
  data?: Record<string, unknown>;
  source?: JobEventSource;
}

export async function appendJobEvent(
  db: JobEventDatabase,
  input: AppendJobEventInput,
): Promise<JobEventDto> {
  const [job] = await db
    .update(schema.generationJobs)
    .set({
      eventSequence: sql`${schema.generationJobs.eventSequence} + 1`,
    })
    .where(eq(schema.generationJobs.id, input.jobId))
    .returning({ sequence: schema.generationJobs.eventSequence });

  if (!job) throw new Error("Generation job not found.");

  const [event] = await db
    .insert(schema.jobEvents)
    .values({
      jobId: input.jobId,
      sequence: job.sequence,
      source: input.source ?? "api",
      type: input.type,
      message: input.message,
      data: input.data,
    })
    .returning();

  return toJobEventDto(event);
}

export function toJobEventDto(
  event: typeof schema.jobEvents.$inferSelect,
): JobEventDto {
  return {
    id: event.id,
    jobId: event.jobId,
    sequence: event.sequence,
    source: event.source as JobEventSource,
    type: event.type,
    message: event.message,
    data: event.data ?? null,
    createdAt: event.createdAt.toISOString(),
  };
}
