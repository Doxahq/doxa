import {
  doxabotBatchQuietMinutesSchema,
  type DoxabotBatchQuietMinutes,
  type DoxabotMergeTrigger,
  type RepositoryVisibility,
  type SourceProvider,
  type UpdateDoxabotSettingsInput,
} from "@doxahq/contracts";
import { createDb, schema, type DbEnv } from "@doxahq/db";
import { and, eq } from "drizzle-orm";
import { isClearedGenerationBaseline } from "./generation-baseline-reset";

export type DoxabotProjectRepositoryState =
  | { connected: false }
  | {
      connected: true;
      visibility: RepositoryVisibility;
    };

export interface DoxabotProjectSettingsState {
  projectId: string;
  ownerUserId: string;
  repository: DoxabotProjectRepositoryState;
  hasPublishedVersion: boolean;
  storedEnabled: boolean;
  mergeTrigger: DoxabotMergeTrigger;
  batchQuietMinutes: DoxabotBatchQuietMinutes;
  updatedAt: Date | null;
}

/** The merge settings of a project without a settings row. */
export const DEFAULT_MERGE_SETTINGS = {
  mergeTrigger: "batched",
  batchQuietMinutes: 30,
} as const satisfies {
  mergeTrigger: DoxabotMergeTrigger;
  batchQuietMinutes: DoxabotBatchQuietMinutes;
};

export interface DoxabotAutomationContext {
  projectId: string;
  ownerUserId: string;
  repositoryExternalId: string;
  installationExternalId: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryVisibility: RepositoryVisibility;
  defaultBranch: string;
  storedEnabled: boolean;
  mergeTrigger: DoxabotMergeTrigger;
  publishedVersionId: string | null;
  publishedSourceRevision: string | null;
}

export interface DoxabotSettingsStore {
  getProjectState(projectId: string): Promise<DoxabotProjectSettingsState | null>;
  /** Stores the fields that the update names and keeps the others. */
  update(input: {
    projectId: string;
    changes: UpdateDoxabotSettingsInput;
    updatedByUserId: string;
  }): Promise<Date>;
  getAutomationContext(input: {
    provider: SourceProvider;
    repositoryExternalId: string;
    installationExternalId: string;
  }): Promise<DoxabotAutomationContext | null>;
}

export class DoxabotSettingsRepository implements DoxabotSettingsStore {
  private readonly db;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  async getProjectState(
    projectId: string,
  ): Promise<DoxabotProjectSettingsState | null> {
    const [row] = await this.db
      .select({
        projectId: schema.projects.id,
        ownerUserId: schema.projects.userId,
        repositoryId: schema.githubRepositories.id,
        repositoryIsPrivate: schema.githubRepositories.isPrivate,
        publishedVersionId: schema.docsSites.publishedVersionId,
        storedEnabled: schema.doxabotAutomationSettings.enabled,
        mergeTrigger: schema.doxabotAutomationSettings.mergeTrigger,
        batchQuietMinutes: schema.doxabotAutomationSettings.batchQuietMinutes,
        settingsUpdatedAt: schema.doxabotAutomationSettings.updatedAt,
      })
      .from(schema.projects)
      .leftJoin(
        schema.githubRepositories,
        eq(schema.projects.githubRepositoryId, schema.githubRepositories.id),
      )
      .leftJoin(
        schema.docsSites,
        eq(schema.projects.id, schema.docsSites.projectId),
      )
      .leftJoin(
        schema.doxabotAutomationSettings,
        eq(
          schema.projects.id,
          schema.doxabotAutomationSettings.projectId,
        ),
      )
      .where(eq(schema.projects.id, projectId))
      .limit(1);

    if (!row) return null;

    return {
      projectId: row.projectId,
      ownerUserId: row.ownerUserId,
      repository: row.repositoryId
        ? {
            connected: true,
            visibility: row.repositoryIsPrivate ? "private" : "public",
          }
        : { connected: false },
      hasPublishedVersion: row.publishedVersionId !== null,
      storedEnabled: row.storedEnabled ?? false,
      mergeTrigger: row.mergeTrigger ?? DEFAULT_MERGE_SETTINGS.mergeTrigger,
      batchQuietMinutes: toBatchQuietMinutes(row.batchQuietMinutes),
      updatedAt: row.settingsUpdatedAt,
    };
  }

  async update(input: {
    projectId: string;
    changes: UpdateDoxabotSettingsInput;
    updatedByUserId: string;
  }): Promise<Date> {
    const [settings] = await this.db
      .insert(schema.doxabotAutomationSettings)
      .values({
        projectId: input.projectId,
        ...input.changes,
        updatedByUserId: input.updatedByUserId,
      })
      .onConflictDoUpdate({
        target: schema.doxabotAutomationSettings.projectId,
        set: {
          ...input.changes,
          updatedByUserId: input.updatedByUserId,
          updatedAt: new Date(),
        },
      })
      .returning({ updatedAt: schema.doxabotAutomationSettings.updatedAt });

    if (!settings) {
      throw new Error("Doxabot settings could not be updated.");
    }
    return settings.updatedAt;
  }

  async getAutomationContext(input: {
    provider: SourceProvider;
    repositoryExternalId: string;
    installationExternalId: string;
  }): Promise<DoxabotAutomationContext | null> {
    if (input.provider !== "github") return null;

    const [row] = await this.db
      .select({
        projectId: schema.projects.id,
        ownerUserId: schema.projects.userId,
        repositoryExternalId: schema.githubRepositories.githubRepoId,
        installationExternalId: schema.githubInstallations.installationId,
        repositoryOwner: schema.githubRepositories.owner,
        repositoryName: schema.githubRepositories.name,
        repositoryIsPrivate: schema.githubRepositories.isPrivate,
        defaultBranch: schema.githubRepositories.defaultBranch,
        storedEnabled: schema.doxabotAutomationSettings.enabled,
        mergeTrigger: schema.doxabotAutomationSettings.mergeTrigger,
        publishedVersionId: schema.docsSites.publishedVersionId,
        publishedSourceRevision: schema.docsVersions.sourceRevision,
        publishedVersionCreatedAt: schema.docsVersions.createdAt,
        generationBaselineResetAt:
          schema.docsSites.generationBaselineResetAt,
      })
      .from(schema.githubRepositories)
      .innerJoin(
        schema.githubInstallations,
        eq(
          schema.githubRepositories.installationId,
          schema.githubInstallations.id,
        ),
      )
      .innerJoin(
        schema.projects,
        eq(
          schema.githubRepositories.id,
          schema.projects.githubRepositoryId,
        ),
      )
      .innerJoin(
        schema.docsSites,
        eq(schema.projects.id, schema.docsSites.projectId),
      )
      .leftJoin(
        schema.doxabotAutomationSettings,
        eq(
          schema.projects.id,
          schema.doxabotAutomationSettings.projectId,
        ),
      )
      .leftJoin(
        schema.docsVersions,
        eq(
          schema.docsSites.publishedVersionId,
          schema.docsVersions.id,
        ),
      )
      .where(
        and(
          eq(
            schema.githubRepositories.githubRepoId,
            input.repositoryExternalId,
          ),
          eq(
            schema.githubInstallations.installationId,
            input.installationExternalId,
          ),
          eq(
            schema.githubInstallations.userId,
            schema.projects.userId,
          ),
        ),
      )
      .limit(1);

    if (!row) return null;
    return {
      projectId: row.projectId,
      ownerUserId: row.ownerUserId,
      repositoryExternalId: row.repositoryExternalId,
      installationExternalId: row.installationExternalId,
      repositoryOwner: row.repositoryOwner,
      repositoryName: row.repositoryName,
      repositoryVisibility: row.repositoryIsPrivate ? "private" : "public",
      defaultBranch: row.defaultBranch,
      storedEnabled: row.storedEnabled ?? false,
      mergeTrigger: row.mergeTrigger ?? DEFAULT_MERGE_SETTINGS.mergeTrigger,
      // A cleared generation cache also retires the published version as a
      // preview baseline, so the next preview run analyzes from scratch
      // instead of silently falling back to pre-reset state.
      ...(row.publishedVersionCreatedAt &&
          isClearedGenerationBaseline({
            versionCreatedAt: row.publishedVersionCreatedAt,
            generationBaselineResetAt: row.generationBaselineResetAt,
          })
        ? { publishedVersionId: null, publishedSourceRevision: null }
        : {
            publishedVersionId: row.publishedVersionId,
            publishedSourceRevision: row.publishedSourceRevision,
          }),
    };
  }
}

/** The stored quiet time, or the default when the project has no row. */
export function toBatchQuietMinutes(
  value: number | null,
): DoxabotBatchQuietMinutes {
  const parsed = doxabotBatchQuietMinutesSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : DEFAULT_MERGE_SETTINGS.batchQuietMinutes;
}
