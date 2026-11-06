import { and, eq } from "drizzle-orm";
import { createDb, schema, type DbEnv } from "@doxahq/db";
import { generationStateOwnerVersionId } from "@doxahq/docs-engine";
import { hasHandWrittenPublication } from "./docs-publications";
import { isClearedGenerationBaseline } from "./generation-baseline-reset";

export interface ProductionGenerationBaseline {
  versionId: string;
  sourceRevision: string;
  sourceTreeHash: string;
  generatorFingerprint: string | null;
  siteId: string;
  /** Where the state of the run that wrote this version lives. */
  generationStatePrefix: string;
}

export interface ProductionBaselineCandidate {
  projectId: string;
  publishedVersionId: string | null;
  versionId: string;
  siteId: string;
  versionChannel: "production" | "preview";
  sourceRevision: string | null;
  sourceTreeHash: string | null;
  generatorFingerprint: string | null;
  generationStatePrefix: string;
  versionCreatedAt: Date;
  generationBaselineResetAt: Date | null;
}

export interface ProductionBaselinesStore {
  findCompatiblePublished(input: {
    projectId: string;
  }): Promise<ProductionGenerationBaseline | null>;
  /**
   * The published version of the project's site when a person published
   * content on it, or null. A seeded run reads this version.
   */
  handWrittenVersion(input: { projectId: string }): Promise<string | null>;
}

export class ProductionBaselinesRepository
  implements ProductionBaselinesStore
{
  private readonly db;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  async handWrittenVersion(input: {
    projectId: string;
  }): Promise<string | null> {
    const [site] = await this.db
      .select({
        id: schema.docsSites.id,
        publishedVersionId: schema.docsSites.publishedVersionId,
      })
      .from(schema.docsSites)
      .where(eq(schema.docsSites.projectId, input.projectId))
      .limit(1);

    if (!site?.publishedVersionId) return null;
    return (await hasHandWrittenPublication(this.db, site.id))
      ? site.publishedVersionId
      : null;
  }

  async findCompatiblePublished(input: {
    projectId: string;
  }): Promise<ProductionGenerationBaseline | null> {
    const [candidate] = await this.db
      .select({
        projectId: schema.docsSites.projectId,
        publishedVersionId: schema.docsSites.publishedVersionId,
        versionId: schema.docsVersions.id,
        siteId: schema.docsVersions.siteId,
        versionChannel: schema.docsVersions.channel,
        sourceRevision: schema.docsVersions.sourceRevision,
        sourceTreeHash: schema.docsVersions.sourceTreeHash,
        generatorFingerprint:
          schema.docsVersions.generatorFingerprint,
        generationStatePrefix:
          schema.docsVersions.generationStatePrefix,
        versionCreatedAt: schema.docsVersions.createdAt,
        generationBaselineResetAt:
          schema.docsSites.generationBaselineResetAt,
      })
      .from(schema.docsSites)
      .innerJoin(
        schema.docsVersions,
        and(
          eq(
            schema.docsSites.publishedVersionId,
            schema.docsVersions.id,
          ),
          eq(schema.docsSites.id, schema.docsVersions.siteId),
        ),
      )
      .where(
        and(
          eq(schema.docsSites.projectId, input.projectId),
          eq(schema.docsVersions.channel, "production"),
        ),
      )
      .limit(1);

    return resolveCompatibleProductionBaseline(candidate, input);
  }
}

export function resolveCompatibleProductionBaseline(
  candidate: ProductionBaselineCandidate | undefined,
  input: {
    projectId: string;
  },
): ProductionGenerationBaseline | null {
  if (
    !candidate ||
    candidate.projectId !== input.projectId ||
    candidate.publishedVersionId !== candidate.versionId ||
    candidate.versionChannel !== "production" ||
    !candidate.sourceRevision ||
    !candidate.sourceTreeHash ||
    generationStateOwnerVersionId(
      candidate.siteId,
      candidate.generationStatePrefix,
    ) === null ||
    isClearedGenerationBaseline(candidate)
  ) {
    return null;
  }

  return {
    versionId: candidate.versionId,
    sourceRevision: candidate.sourceRevision,
    sourceTreeHash: candidate.sourceTreeHash,
    generatorFingerprint: candidate.generatorFingerprint,
    siteId: candidate.siteId,
    generationStatePrefix: candidate.generationStatePrefix,
  };
}
