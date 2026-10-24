import type { GenerationExecutionContext } from "@doxahq/contracts";
import { createDb, schema, type DoxaDb } from "@doxahq/db";
import { eq } from "drizzle-orm";
import type { Env } from "../env";
import { listSiteLocks } from "../repositories/page-locks";

/**
 * Adds the inputs that a run takes from the site, not from the job: the pages
 * that a person locked, which the worker keeps as published, and the
 * hand-written version of a seeded first run.
 */
export async function withRunInputs(
  env: Env,
  context: GenerationExecutionContext | null,
): Promise<GenerationExecutionContext | null> {
  if (!context) return null;

  const db = createDb(env);
  const [locks, seedVersion] = await Promise.all([
    listSiteLocks(db, context.project.siteId),
    readSeedVersion(db, context.job.id),
  ]);

  return {
    ...context,
    pageLocks: { locked: locks.map((lock) => lock.href) },
    seedVersion,
  };
}

async function readSeedVersion(
  db: DoxaDb,
  jobId: string,
): Promise<{ id: string; artifactPrefix: string } | null> {
  const [row] = await db
    .select({
      id: schema.docsVersions.id,
      artifactPrefix: schema.docsVersions.artifactPrefix,
    })
    .from(schema.generationJobs)
    .innerJoin(
      schema.docsVersions,
      eq(schema.docsVersions.id, schema.generationJobs.seedVersionId),
    )
    .where(eq(schema.generationJobs.id, jobId))
    .limit(1);

  return row ?? null;
}
