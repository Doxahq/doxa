import type { RepositoryVisibility } from "@doxahq/contracts";
import { createDb, schema, type DbEnv } from "@doxahq/db";
import { and, eq, isNotNull } from "drizzle-orm";

export type GitHubInstallationStatus = "active" | "suspended" | "deleted";
export type RepositoryDisconnectReason = "removed" | "deleted";

/**
 * Why a project's repository cannot be used now. Doxabot ignores its events
 * and generations refuse to start, but the site stays live (Decision 4).
 */
export type RepositoryConnectionIssue =
  | "repository_removed"
  | "repository_deleted"
  | "installation_suspended"
  | "installation_deleted";

/** The issue of a repository row and its installation row, or null. */
export function repositoryConnectionIssue(input: {
  installationStatus: GitHubInstallationStatus;
  disconnectedReason: RepositoryDisconnectReason | null;
}): RepositoryConnectionIssue | null {
  if (input.installationStatus === "suspended") return "installation_suspended";
  if (input.installationStatus === "deleted") return "installation_deleted";
  if (input.disconnectedReason === "deleted") return "repository_deleted";
  if (input.disconnectedReason === "removed") return "repository_removed";
  return null;
}

/** What GitHub says changed about one repository. */
export interface RepositoryRecordUpdate {
  repositoryExternalId: string;
  visibility: RepositoryVisibility;
  fullName?: string;
  owner?: string;
  name?: string;
  defaultBranch?: string;
}

/** One repository of one installation, by their GitHub IDs. */
export interface RepositoryIdentity {
  repositoryExternalId: string;
  installationExternalId: string;
}

/** A repository that an installation got, with all that its row needs. */
export interface NewRepositoryRecord extends RepositoryIdentity {
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  visibility: RepositoryVisibility;
}

/**
 * The record updates of GitHub lifecycle events: uninstall, suspend,
 * repositories removed from the app, renames, transfers and visibility
 * changes. Rows are never deleted here, so the site of a project stays live.
 */
export interface RepositoryLifecycleStore {
  /** Rows changed; 0 when Doxa does not know the installation. */
  setInstallationStatus(input: {
    installationExternalId: string;
    status: GitHubInstallationStatus;
    at: Date;
  }): Promise<number>;
  /**
   * Marks the repository disconnected, only when its row belongs to this
   * installation. False when no such row exists.
   */
  disconnectRepository(input: {
    repositoryExternalId: string;
    installationExternalId: string;
    reason: RepositoryDisconnectReason;
    at: Date;
  }): Promise<boolean>;
  /**
   * Clears the disconnect of a repository that the app got back, only when
   * its row belongs to this installation.
   */
  reconnectRepository(input: {
    repositoryExternalId: string;
    installationExternalId: string;
    visibility: RepositoryVisibility;
  }): Promise<boolean>;
  /**
   * True when Doxa knows the installation and has no row for the repository
   * yet: only then can {@link addRepository} write one.
   */
  canAddRepository(input: RepositoryIdentity): Promise<boolean>;
  /**
   * Adds a row for a repository that the installation got, when Doxa knows
   * the installation. A row that already exists stays as it is, also when it
   * belongs to another installation: an event never moves a repository.
   * True when a row was written.
   */
  addRepository(input: NewRepositoryRecord): Promise<boolean>;
  /**
   * Updates names, owner and visibility by the GitHub repository ID, which a
   * rename or a transfer does not change. Null when Doxa does not know the
   * repository; else its visibility before the update and its projects.
   */
  updateRepository(input: RepositoryRecordUpdate): Promise<{
    previousVisibility: RepositoryVisibility;
    projectIds: string[];
  } | null>;
  /**
   * Turns Doxabot off for these projects and records why: previews off and
   * merges manual. The owner turns it on again in the settings.
   */
  pauseAutomation(input: {
    projectIds: readonly string[];
    reason: "repository_privatized";
    at: Date;
  }): Promise<void>;
  /**
   * Keeps the GitHub user who installed the app, from the `created` event.
   * The first record stays: a redelivery has the same sender. True when a
   * row was written.
   */
  recordInstaller(input: {
    installationExternalId: string;
    installer: GitHubInstaller;
  }): Promise<boolean>;
}

/** The GitHub user who installed the app (the `sender` of `installation.created`). */
export interface GitHubInstaller {
  githubUserId: string;
  login: string;
}

export class GitHubLifecycleRepository implements RepositoryLifecycleStore {
  private readonly db;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  async setInstallationStatus(input: {
    installationExternalId: string;
    status: GitHubInstallationStatus;
    at: Date;
  }): Promise<number> {
    const updated = await this.db
      .update(schema.githubInstallations)
      .set({ status: input.status, statusChangedAt: input.at, updatedAt: input.at })
      .where(eq(schema.githubInstallations.installationId, input.installationExternalId))
      .returning({ id: schema.githubInstallations.id });
    return updated.length;
  }

  async disconnectRepository(input: {
    repositoryExternalId: string;
    installationExternalId: string;
    reason: RepositoryDisconnectReason;
    at: Date;
  }): Promise<boolean> {
    const installationRowId = await this.installationRowId(input.installationExternalId);
    if (!installationRowId) return false;
    const updated = await this.db
      .update(schema.githubRepositories)
      .set({ disconnectedAt: input.at, disconnectedReason: input.reason, updatedAt: input.at })
      .where(
        and(
          eq(schema.githubRepositories.githubRepoId, input.repositoryExternalId),
          eq(schema.githubRepositories.installationId, installationRowId),
        ),
      )
      .returning({ id: schema.githubRepositories.id });
    return updated.length > 0;
  }

  async reconnectRepository(input: {
    repositoryExternalId: string;
    installationExternalId: string;
    visibility: RepositoryVisibility;
  }): Promise<boolean> {
    const installationRowId = await this.installationRowId(input.installationExternalId);
    if (!installationRowId) return false;
    const updated = await this.db
      .update(schema.githubRepositories)
      .set({
        disconnectedAt: null,
        disconnectedReason: null,
        isPrivate: input.visibility === "private",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.githubRepositories.githubRepoId, input.repositoryExternalId),
          eq(schema.githubRepositories.installationId, installationRowId),
          isNotNull(schema.githubRepositories.disconnectedAt),
        ),
      )
      .returning({ id: schema.githubRepositories.id });
    return updated.length > 0;
  }

  async canAddRepository(input: RepositoryIdentity): Promise<boolean> {
    const installationRowId = await this.installationRowId(input.installationExternalId);
    if (!installationRowId) return false;
    const [row] = await this.db
      .select({ id: schema.githubRepositories.id })
      .from(schema.githubRepositories)
      .where(eq(schema.githubRepositories.githubRepoId, input.repositoryExternalId))
      .limit(1);
    return !row;
  }

  async addRepository(input: NewRepositoryRecord): Promise<boolean> {
    const installationRowId = await this.installationRowId(input.installationExternalId);
    if (!installationRowId) return false;
    const inserted = await this.db
      .insert(schema.githubRepositories)
      .values({
        installationId: installationRowId,
        githubRepoId: input.repositoryExternalId,
        fullName: input.fullName,
        owner: input.owner,
        name: input.name,
        defaultBranch: input.defaultBranch,
        isPrivate: input.visibility === "private",
      })
      .onConflictDoNothing({ target: schema.githubRepositories.githubRepoId })
      .returning({ id: schema.githubRepositories.id });
    return inserted.length > 0;
  }

  async updateRepository(input: RepositoryRecordUpdate): Promise<{
    previousVisibility: RepositoryVisibility;
    projectIds: string[];
  } | null> {
    return this.db.transaction(async (tx) => {
      // The row lock orders two events about the same repository.
      const [current] = await tx
        .select({
          id: schema.githubRepositories.id,
          isPrivate: schema.githubRepositories.isPrivate,
        })
        .from(schema.githubRepositories)
        .where(eq(schema.githubRepositories.githubRepoId, input.repositoryExternalId))
        .for("update")
        .limit(1);
      if (!current) return null;

      await tx
        .update(schema.githubRepositories)
        .set({
          isPrivate: input.visibility === "private",
          ...(input.fullName ? { fullName: input.fullName } : {}),
          ...(input.owner ? { owner: input.owner } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(input.defaultBranch ? { defaultBranch: input.defaultBranch } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.githubRepositories.id, current.id));

      const projects = await tx
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.githubRepositoryId, current.id));
      return {
        previousVisibility: current.isPrivate ? "private" : "public",
        projectIds: projects.map((project) => project.id),
      };
    });
  }

  async pauseAutomation(input: {
    projectIds: readonly string[];
    reason: "repository_privatized";
    at: Date;
  }): Promise<void> {
    if (input.projectIds.length === 0) return;
    const paused = {
      enabled: false,
      mergeTrigger: "manual" as const,
      pausedReason: input.reason,
      pausedAt: input.at,
    };
    await this.db
      .insert(schema.doxabotAutomationSettings)
      .values(input.projectIds.map((projectId) => ({ projectId, ...paused })))
      .onConflictDoUpdate({
        target: schema.doxabotAutomationSettings.projectId,
        set: { ...paused, updatedAt: input.at },
      });
  }

  async recordInstaller(input: {
    installationExternalId: string;
    installer: GitHubInstaller;
  }): Promise<boolean> {
    const inserted = await this.db
      .insert(schema.githubInstallationInstallers)
      .values({
        installationId: input.installationExternalId,
        installerGithubUserId: input.installer.githubUserId,
        installerLogin: input.installer.login,
      })
      .onConflictDoNothing({ target: schema.githubInstallationInstallers.installationId })
      .returning({ installationId: schema.githubInstallationInstallers.installationId });
    return inserted.length > 0;
  }

  /** The installer, or null while the `created` webhook did not arrive. */
  async findInstaller(installationExternalId: string): Promise<GitHubInstaller | null> {
    const [row] = await this.db
      .select({
        githubUserId: schema.githubInstallationInstallers.installerGithubUserId,
        login: schema.githubInstallationInstallers.installerLogin,
      })
      .from(schema.githubInstallationInstallers)
      .where(eq(schema.githubInstallationInstallers.installationId, installationExternalId))
      .limit(1);
    return row ?? null;
  }

  private async installationRowId(installationExternalId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: schema.githubInstallations.id })
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.installationId, installationExternalId))
      .limit(1);
    return row?.id ?? null;
  }
}

/**
 * The connection issue of a project's repository, or null when it can be
 * used. Also null when the project has no repository: the caller checks that
 * first.
 */
export async function findProjectRepositoryIssue(
  env: DbEnv,
  projectId: string,
): Promise<RepositoryConnectionIssue | null> {
  const [row] = await createDb(env)
    .select({
      installationStatus: schema.githubInstallations.status,
      disconnectedReason: schema.githubRepositories.disconnectedReason,
    })
    .from(schema.projects)
    .innerJoin(
      schema.githubRepositories,
      eq(schema.projects.githubRepositoryId, schema.githubRepositories.id),
    )
    .innerJoin(
      schema.githubInstallations,
      eq(schema.githubRepositories.installationId, schema.githubInstallations.id),
    )
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  return row ? repositoryConnectionIssue(row) : null;
}
