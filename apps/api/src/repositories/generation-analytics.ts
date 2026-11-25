import { eq } from "drizzle-orm";
import { createDb, schema, type DbEnv } from "@doxahq/db";
import type { GenerationJobDto, GenerationJobTrigger } from "@doxahq/contracts";

/** What `generation_finished` reads about an ended job: no names, no text. */
export interface GenerationEndFacts {
  readonly projectId: string;
  readonly status: GenerationJobDto["status"];
  readonly trigger: GenerationJobTrigger;
  readonly publicationMode: "production" | "preview";
  /** The person who started the run, else the project owner (a Doxabot run). */
  readonly userId: string;
  readonly createdAt: Date;
  readonly endedAt: Date;
}

export interface GenerationEndFactsStore {
  endFacts(jobId: string): Promise<GenerationEndFacts | null>;
}

/** One primary-key read of the job and its project. */
export class GenerationAnalyticsRepository implements GenerationEndFactsStore {
  constructor(private readonly env: DbEnv) {}

  async endFacts(jobId: string): Promise<GenerationEndFacts | null> {
    const jobs = schema.generationJobs;
    const [row] = await createDb(this.env)
      .select({
        projectId: jobs.projectId,
        status: jobs.status,
        trigger: jobs.trigger,
        publicationMode: jobs.publicationMode,
        requestedByUserId: jobs.requestedByUserId,
        ownerUserId: schema.projects.userId,
        createdAt: jobs.createdAt,
        updatedAt: jobs.updatedAt,
      })
      .from(jobs)
      .innerJoin(schema.projects, eq(schema.projects.id, jobs.projectId))
      .where(eq(jobs.id, jobId))
      .limit(1);
    if (!row) return null;
    return {
      projectId: row.projectId,
      status: row.status,
      trigger: row.trigger,
      publicationMode: row.publicationMode,
      userId: row.requestedByUserId ?? row.ownerUserId,
      createdAt: row.createdAt,
      endedAt: row.updatedAt,
    };
  }
}
