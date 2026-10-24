import { and, eq } from "drizzle-orm";
import { createDb, schema, type DoxaDb } from "@doxahq/db";
import type { GenerationJobDto } from "@doxahq/contracts";

/** One version folder that the changes of a run read. */
export interface ChangesVersion {
  versionId: string;
  artifactPrefix: string;
  /** True when retention deleted the files of the version. */
  isCollected: boolean;
}

/** What the changes of one run are read from. */
export interface GenerationChangesSnapshot {
  jobId: string;
  status: GenerationJobDto["status"];
  publicationMode: "production" | "preview";
  siteSlug: string | null;
  /** The version that the run wrote, or null when it wrote none. */
  generated: ChangesVersion | null;
  /**
   * The version that the pages compare with: the version the run was built
   * on, else the live version, whichever still has its files. Null when no
   * such version exists.
   */
  base: ChangesVersion | null;
}

/** Reads what the read-only changes of a run need. */
export class GenerationChangesRepository {
  private readonly db: DoxaDb;

  constructor(env: Parameters<typeof createDb>[0]) {
    this.db = createDb(env);
  }

  /** The run of a project that `ownerUserId` owns, or null. */
  async snapshot(input: {
    ownerUserId: string;
    projectId: string;
    jobId: string;
  }): Promise<GenerationChangesSnapshot | null> {
    const [row] = await this.db
      .select({
        jobId: schema.generationJobs.id,
        status: schema.generationJobs.status,
        publicationMode: schema.generationJobs.publicationMode,
        siteSlug: schema.docsSites.slug,
        publishedVersionId: schema.docsSites.publishedVersionId,
        generatedVersionId: schema.docsVersions.id,
        generatedPrefix: schema.docsVersions.artifactPrefix,
        generatedCollectedAt: schema.docsVersions.artifactsCollectedAt,
        baselineVersionId: schema.docsVersions.baselineVersionId,
      })
      .from(schema.generationJobs)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.generationJobs.projectId))
      .leftJoin(schema.docsSites, eq(schema.docsSites.projectId, schema.projects.id))
      .leftJoin(schema.docsVersions, eq(schema.docsVersions.id, schema.generationJobs.docsVersionId))
      .where(
        and(
          eq(schema.projects.userId, input.ownerUserId),
          eq(schema.generationJobs.projectId, input.projectId),
          eq(schema.generationJobs.id, input.jobId),
        ),
      )
      .limit(1);
    if (!row) return null;

    const generated =
      row.generatedVersionId && row.generatedPrefix
        ? {
            versionId: row.generatedVersionId,
            artifactPrefix: row.generatedPrefix,
            isCollected: row.generatedCollectedAt !== null,
          }
        : null;
    return {
      jobId: row.jobId,
      status: row.status,
      publicationMode: row.publicationMode,
      siteSlug: row.siteSlug,
      generated,
      base: await this.readableBase([row.baselineVersionId, row.publishedVersionId]),
    };
  }

  /** The first of the candidate versions whose files retention kept. */
  private async readableBase(candidates: ReadonlyArray<string | null>): Promise<ChangesVersion | null> {
    for (const versionId of new Set(candidates)) {
      if (!versionId) continue;
      const version = await this.version(versionId);
      if (version && !version.isCollected) return version;
    }
    return null;
  }

  private async version(versionId: string): Promise<ChangesVersion | null> {
    const [row] = await this.db
      .select({
        artifactPrefix: schema.docsVersions.artifactPrefix,
        collectedAt: schema.docsVersions.artifactsCollectedAt,
      })
      .from(schema.docsVersions)
      .where(eq(schema.docsVersions.id, versionId))
      .limit(1);

    return row
      ? { versionId, artifactPrefix: row.artifactPrefix, isCollected: row.collectedAt !== null }
      : null;
  }
}
