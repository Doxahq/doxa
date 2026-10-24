import type { GenerationJobTrigger, SourceProvider } from "@doxahq/contracts";
import {
  createDb,
  schema,
  type DbEnv,
} from "@doxahq/db";
import { and, desc, eq } from "drizzle-orm";
import { isClearedGenerationBaseline } from "./generation-baseline-reset";

export interface SuccessfulPreviewBaseline {
  versionId: string;
  sourceRevision: string;
}

export interface PreviewBaselineCandidate {
  projectId: string;
  provider: SourceProvider | null;
  changeExternalId: string | null;
  currentVersionId: string | null;
  versionId: string;
  siteId: string;
  versionChannel: "production" | "preview";
  sourceRevision: string | null;
  sourceTreeHash: string | null;
  versionGeneratorFingerprint: string | null;
  generationStatePrefix: string;
  jobStatus: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  jobTrigger: GenerationJobTrigger;
  jobPublicationMode: "production" | "preview";
  jobProvider: SourceProvider | null;
  jobChangeExternalId: string | null;
  jobTargetRevision: string | null;
  jobGeneratorFingerprint: string | null;
  versionCreatedAt: Date;
  generationBaselineResetAt: Date | null;
}

export interface PreviewBaselinesStore {
  findSuccessfulCompatiblePreview(input: {
    projectId: string;
    provider: SourceProvider;
    changeExternalId: string;
  }): Promise<SuccessfulPreviewBaseline | null>;
}

export class PreviewBaselinesRepository
  implements PreviewBaselinesStore
{
  private readonly db;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  async findSuccessfulCompatiblePreview(input: {
    projectId: string;
    provider: SourceProvider;
    changeExternalId: string;
  }): Promise<SuccessfulPreviewBaseline | null> {
    const [candidate] = await this.db
      .select({
        projectId: schema.docsPreviewChannels.projectId,
        provider: schema.docsPreviewChannels.provider,
        changeExternalId:
          schema.docsPreviewChannels.changeExternalId,
        currentVersionId:
          schema.docsPreviewChannels.currentVersionId,
        versionId: schema.docsVersions.id,
        siteId: schema.docsVersions.siteId,
        versionChannel: schema.docsVersions.channel,
        sourceRevision: schema.docsVersions.sourceRevision,
        sourceTreeHash: schema.docsVersions.sourceTreeHash,
        versionGeneratorFingerprint:
          schema.docsVersions.generatorFingerprint,
        generationStatePrefix:
          schema.docsVersions.generationStatePrefix,
        jobStatus: schema.generationJobs.status,
        jobTrigger: schema.generationJobs.trigger,
        jobPublicationMode:
          schema.generationJobs.publicationMode,
        jobProvider: schema.generationJobs.sourceProvider,
        jobChangeExternalId:
          schema.generationJobs.changeExternalId,
        jobTargetRevision:
          schema.generationJobs.targetRevision,
        jobGeneratorFingerprint:
          schema.generationJobs.generatorFingerprint,
        versionCreatedAt: schema.docsVersions.createdAt,
        generationBaselineResetAt:
          schema.docsSites.generationBaselineResetAt,
      })
      .from(schema.docsPreviewChannels)
      .innerJoin(
        schema.docsVersions,
        and(
          eq(
            schema.docsPreviewChannels.currentVersionId,
            schema.docsVersions.id,
          ),
          eq(
            schema.docsPreviewChannels.siteId,
            schema.docsVersions.siteId,
          ),
        ),
      )
      .innerJoin(
        schema.generationJobs,
        and(
          eq(
            schema.generationJobs.docsVersionId,
            schema.docsVersions.id,
          ),
          eq(
            schema.generationJobs.projectId,
            schema.docsPreviewChannels.projectId,
          ),
        ),
      )
      .innerJoin(
        schema.docsSites,
        eq(schema.docsSites.id, schema.docsVersions.siteId),
      )
      .where(
        and(
          eq(
            schema.docsPreviewChannels.projectId,
            input.projectId,
          ),
          eq(
            schema.docsPreviewChannels.provider,
            input.provider,
          ),
          eq(
            schema.docsPreviewChannels.changeExternalId,
            input.changeExternalId,
          ),
          eq(schema.docsVersions.channel, "preview"),
          eq(schema.generationJobs.status, "succeeded"),
          eq(schema.generationJobs.trigger, "doxabot"),
          eq(
            schema.generationJobs.publicationMode,
            "preview",
          ),
          eq(
            schema.generationJobs.sourceProvider,
            input.provider,
          ),
          eq(
            schema.generationJobs.changeExternalId,
            input.changeExternalId,
          ),
        ),
      )
      .orderBy(desc(schema.generationJobs.updatedAt))
      .limit(1);

    return resolveCompatiblePreviewBaseline(candidate, input);
  }
}

export function resolveCompatiblePreviewBaseline(
  candidate: PreviewBaselineCandidate | undefined,
  input: {
    projectId: string;
    provider: SourceProvider;
    changeExternalId: string;
  },
): SuccessfulPreviewBaseline | null {
  if (
    !candidate ||
    candidate.projectId !== input.projectId ||
    candidate.provider !== input.provider ||
    candidate.changeExternalId !== input.changeExternalId ||
    candidate.currentVersionId !== candidate.versionId ||
    candidate.versionChannel !== "preview" ||
    candidate.jobStatus !== "succeeded" ||
    candidate.jobTrigger !== "doxabot" ||
    candidate.jobPublicationMode !== "preview" ||
    candidate.jobProvider !== input.provider ||
    candidate.jobChangeExternalId !== input.changeExternalId ||
    candidate.jobTargetRevision !== candidate.sourceRevision ||
    !candidate.sourceRevision ||
    !candidate.sourceTreeHash ||
    candidate.generationStatePrefix !==
      `sites/${candidate.siteId}/generation-state/${candidate.versionId}` ||
    isClearedGenerationBaseline(candidate)
  ) {
    return null;
  }
  return {
    versionId: candidate.versionId,
    sourceRevision: candidate.sourceRevision,
  };
}
