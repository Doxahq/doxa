import {
  doxabotBatchQuietMinutesSchema,
  type DoxabotAutomationWarning,
  type DoxabotBatchQuietMinutes,
  type DoxabotMergeTrigger,
  type RepositoryVisibility,
  type SourceProvider,
  type UpdateDoxabotSettingsInput,
} from "@doxahq/contracts";
import { createDb, schema, type DbEnv } from "@doxahq/db";
import { and, eq } from "drizzle-orm";
import { isClearedGenerationBaseline } from "./generation-baseline-reset";
import {
  repositoryConnectionIssue,
  type RepositoryConnectionIssue,
} from "./github-lifecycle";
import {
  optionalProductionBranchSql,
  productionBranchSql,
} from "./production-branch";

export type DoxabotProjectRepositoryState =
  | { connected: false }
  | {
      connected: true;
      visibility: RepositoryVisibility;
      /** The repository's default branch on GitHub. */
      defaultBranch: string;
      /** The branch that production generations read (`productionBranchSql`). */
      productionBranch: string;
      /** Why the repository cannot be used now; null when it can. */
      connectionIssue: RepositoryConnectionIssue | null;
    };

export interface DoxabotProjectSettingsState {
  projectId: string;
  ownerUserId: string;
  repository: DoxabotProjectRepositoryState;
  hasPublishedVersion: boolean;
  storedEnabled: boolean;
  mergeTrigger: DoxabotMergeTrigger;
  batchQuietMinutes: DoxabotBatchQuietMinutes;
  allowedBotLogins: string[];
  /** Why Doxabot stopped updating the site on its own, or null. */
  automationWarning: DoxabotAutomationWarning | null;
  updatedAt: Date | null;
}

/**
 * The merge settings of a project without a settings row. Merge runs stay
 * off until the owner turns them on (Decision 7).
 */
export const DEFAULT_MERGE_SETTINGS = {
  mergeTrigger: "manual",
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
  /**
   * The branch that production generations read. A pull request must target
   * it for a preview, and a merge into it feeds the merge trigger.
   */
  productionBranch: string;
  storedEnabled: boolean;
  mergeTrigger: DoxabotMergeTrigger;
  /** Bot logins whose pull requests get previews; every other bot is skipped. */
  allowedBotLogins: string[];
  /**
   * Why the repository cannot be used now: removed from the app, deleted, or
   * the installation is suspended or uninstalled. Null when it can.
   */
  connectionIssue: RepositoryConnectionIssue | null;
  /** The site serves a published version. Previews need one to exist. */
  hasPublishedVersion: boolean;
  /**
   * The published version as the baseline of a preview. Null without a
   * published version, and after the generation cache was cleared: then a
   * preview analyzes from scratch instead of reusing pre-reset state.
   */
  publishedBaseline: PublishedPreviewBaseline | null;
}

export interface PublishedPreviewBaseline {
  versionId: string;
  sourceRevision: string | null;
}

export interface DoxabotSettingsStore {
  getProjectState(projectId: string): Promise<DoxabotProjectSettingsState | null>;
  /**
   * Stores the fields that the update names and keeps the others. The
   * production branch goes to the project, the rest to its settings row.
   */
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

/**
 * The published baseline of a project, by the rule of pull request
 * admission (`DoxabotAutomationContext.publishedBaseline`), so the dashboard
 * names the same next-run temperature that the bill uses.
 */
export interface PublishedPreviewBaselineReader {
  getPublishedPreviewBaseline(
    projectId: string,
  ): Promise<PublishedPreviewBaseline | null>;
}

export class DoxabotSettingsRepository
  implements DoxabotSettingsStore, PublishedPreviewBaselineReader
{
  private readonly db;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  async getPublishedPreviewBaseline(
    projectId: string,
  ): Promise<PublishedPreviewBaseline | null> {
    const [row] = await this.db
      .select({
        publishedVersionId: schema.docsSites.publishedVersionId,
        publishedSourceRevision: schema.docsVersions.sourceRevision,
        publishedVersionCreatedAt: schema.docsVersions.createdAt,
        generationBaselineResetAt:
          schema.docsSites.generationBaselineResetAt,
      })
      .from(schema.docsSites)
      .leftJoin(
        schema.docsVersions,
        eq(
          schema.docsSites.publishedVersionId,
          schema.docsVersions.id,
        ),
      )
      .where(eq(schema.docsSites.projectId, projectId))
      .limit(1);

    return row ? toPublishedPreviewBaseline(row) : null;
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
        repositoryDefaultBranch: schema.githubRepositories.defaultBranch,
        repositoryDisconnectedReason: schema.githubRepositories.disconnectedReason,
        installationStatus: schema.githubInstallations.status,
        // A left join: null when the project has no repository.
        productionBranch: optionalProductionBranchSql(),
        publishedVersionId: schema.docsSites.publishedVersionId,
        storedEnabled: schema.doxabotAutomationSettings.enabled,
        mergeTrigger: schema.doxabotAutomationSettings.mergeTrigger,
        batchQuietMinutes: schema.doxabotAutomationSettings.batchQuietMinutes,
        allowedBotLogins: schema.doxabotAutomationSettings.allowedBotLogins,
        pausedReason: schema.doxabotAutomationSettings.pausedReason,
        settingsUpdatedAt: schema.doxabotAutomationSettings.updatedAt,
      })
      .from(schema.projects)
      .leftJoin(
        schema.githubRepositories,
        eq(schema.projects.githubRepositoryId, schema.githubRepositories.id),
      )
      .leftJoin(
        schema.githubInstallations,
        eq(schema.githubRepositories.installationId, schema.githubInstallations.id),
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

    const connectionIssue = row.installationStatus
      ? repositoryConnectionIssue({
          installationStatus: row.installationStatus,
          disconnectedReason: row.repositoryDisconnectedReason,
        })
      : null;
    return {
      projectId: row.projectId,
      ownerUserId: row.ownerUserId,
      repository:
        row.repositoryId && row.repositoryDefaultBranch
          ? {
              connected: true,
              visibility: row.repositoryIsPrivate ? "private" : "public",
              defaultBranch: row.repositoryDefaultBranch,
              productionBranch:
                row.productionBranch ?? row.repositoryDefaultBranch,
              connectionIssue,
            }
          : { connected: false },
      hasPublishedVersion: row.publishedVersionId !== null,
      storedEnabled: row.storedEnabled ?? false,
      mergeTrigger: row.mergeTrigger ?? DEFAULT_MERGE_SETTINGS.mergeTrigger,
      batchQuietMinutes: toBatchQuietMinutes(row.batchQuietMinutes),
      allowedBotLogins: row.allowedBotLogins ?? [],
      automationWarning: connectionIssue ?? row.pausedReason ?? null,
      updatedAt: row.settingsUpdatedAt,
    };
  }

  async update(input: {
    projectId: string;
    changes: UpdateDoxabotSettingsInput;
    updatedByUserId: string;
  }): Promise<Date> {
    const { productionBranch, ...automation } = input.changes;
    return this.db.transaction(async (tx) => {
      if (productionBranch !== undefined) {
        await tx
          .update(schema.projects)
          .set({ productionBranch, updatedAt: new Date() })
          .where(eq(schema.projects.id, input.projectId));
      }

      // The row also records who changed a setting last, so a branch-only
      // update writes it too. A change by the owner is their decision after
      // a pause (Decision 4), so it clears the pause.
      const [settings] = await tx
        .insert(schema.doxabotAutomationSettings)
        .values({
          projectId: input.projectId,
          ...automation,
          updatedByUserId: input.updatedByUserId,
        })
        .onConflictDoUpdate({
          target: schema.doxabotAutomationSettings.projectId,
          set: {
            ...automation,
            pausedReason: null,
            pausedAt: null,
            updatedByUserId: input.updatedByUserId,
            updatedAt: new Date(),
          },
        })
        .returning({ updatedAt: schema.doxabotAutomationSettings.updatedAt });

      if (!settings) {
        throw new Error("Doxabot settings could not be updated.");
      }
      return settings.updatedAt;
    });
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
        productionBranch: productionBranchSql(),
        installationStatus: schema.githubInstallations.status,
        repositoryDisconnectedReason: schema.githubRepositories.disconnectedReason,
        storedEnabled: schema.doxabotAutomationSettings.enabled,
        mergeTrigger: schema.doxabotAutomationSettings.mergeTrigger,
        allowedBotLogins: schema.doxabotAutomationSettings.allowedBotLogins,
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
      productionBranch: row.productionBranch,
      storedEnabled: row.storedEnabled ?? false,
      mergeTrigger: row.mergeTrigger ?? DEFAULT_MERGE_SETTINGS.mergeTrigger,
      allowedBotLogins: row.allowedBotLogins ?? [],
      connectionIssue: repositoryConnectionIssue({
        installationStatus: row.installationStatus,
        disconnectedReason: row.repositoryDisconnectedReason,
      }),
      hasPublishedVersion: row.publishedVersionId !== null,
      publishedBaseline: toPublishedPreviewBaseline(row),
    };
  }
}

/**
 * A cleared generation cache retires the published version as a preview
 * baseline, so the next preview analyzes from scratch instead of silently
 * reusing pre-reset state. Previews stay available: the site still serves
 * the version.
 */
export function toPublishedPreviewBaseline(row: {
  publishedVersionId: string | null;
  publishedSourceRevision: string | null;
  publishedVersionCreatedAt: Date | null;
  generationBaselineResetAt: Date | null;
}): PublishedPreviewBaseline | null {
  if (row.publishedVersionId === null) return null;
  if (
    row.publishedVersionCreatedAt !== null &&
    isClearedGenerationBaseline({
      versionCreatedAt: row.publishedVersionCreatedAt,
      generationBaselineResetAt: row.generationBaselineResetAt,
    })
  ) {
    return null;
  }
  return {
    versionId: row.publishedVersionId,
    sourceRevision: row.publishedSourceRevision,
  };
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
