import { and, asc, desc, eq, isNull, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { createDb, schema } from "@doxahq/db";
import { alias } from "drizzle-orm/pg-core";
import type {
  GenerationContext,
  GitHubInstallationDto,
  GitHubInstallationTransferTargetDto,
  GitHubRepositoryDto,
} from "@doxahq/contracts";
import type { Env } from "../env";
import { productionBranchSql } from "./production-branch";

/** A repository whose branches the API can list, with what a read token needs. */
export interface RepositoryBranchTarget {
  externalId: string;
  owner: string;
  name: string;
  installationId: string;
  /** The repository's default branch on GitHub. */
  defaultBranch: string;
}

export interface ProductionGenerationSourceContext {
  externalId: string;
  owner: string;
  name: string;
  /** The project's production branch (`productionBranchSql`). */
  defaultBranch: string;
  installationId: string;
}

/** An active installation of the owner, for a refresh of its repository list. */
export interface RefreshableInstallation {
  /** The Doxa row ID. */
  id: string;
  /** The GitHub installation ID. */
  installationId: string;
}

export type RepositoryRefreshClaim =
  | { claimed: true }
  | { claimed: false; retryAfterSeconds: number };

export class GitHubRepository {
  private readonly db;

  constructor(env: Env) {
    this.db = createDb(env);
  }

  async listReposForUser(userId: string): Promise<GitHubRepositoryDto[]> {
    const rows = await this.db
      .select({
        id: schema.githubRepositories.id,
        githubRepoId: schema.githubRepositories.githubRepoId,
        fullName: schema.githubRepositories.fullName,
        owner: schema.githubRepositories.owner,
        name: schema.githubRepositories.name,
        defaultBranch: schema.githubRepositories.defaultBranch,
        isPrivate: schema.githubRepositories.isPrivate,
      })
      .from(schema.githubRepositories)
      .innerJoin(
        schema.githubInstallations,
        eq(schema.githubRepositories.installationId, schema.githubInstallations.id),
      )
      .where(eq(schema.githubInstallations.userId, userId))
      .orderBy(desc(schema.githubRepositories.updatedAt));

    return rows;
  }

  /** The Doxa owner of a recorded installation, or null when Doxa has none. */
  async findInstallationOwner(installationId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ userId: schema.githubInstallations.userId })
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.installationId, installationId))
      .limit(1);
    return row?.userId ?? null;
  }

  /** The installations that this user owns, for the owner transfer. */
  async listInstallationsForOwner(userId: string): Promise<GitHubInstallationDto[]> {
    return this.db
      .select({
        id: schema.githubInstallations.id,
        accountLogin: schema.githubInstallations.accountLogin,
        accountType: schema.githubInstallations.accountType,
        status: schema.githubInstallations.status,
      })
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.userId, userId))
      .orderBy(asc(schema.githubInstallations.accountLogin));
  }

  /** The active installations that this user owns. */
  async listRefreshableInstallations(userId: string): Promise<RefreshableInstallation[]> {
    return this.db
      .select({
        id: schema.githubInstallations.id,
        installationId: schema.githubInstallations.installationId,
      })
      .from(schema.githubInstallations)
      .where(
        and(
          eq(schema.githubInstallations.userId, userId),
          eq(schema.githubInstallations.status, "active"),
        ),
      )
      .orderBy(asc(schema.githubInstallations.accountLogin));
  }

  /**
   * Claims a refresh of the repository list of one installation. The claim
   * holds when no refresh ran in the last `cooldownSeconds`. The check and the
   * write are one statement, so two clicks at the same time make one refresh.
   */
  async claimRepositoryRefresh(
    installationRowId: string,
    now: Date,
    cooldownSeconds: number,
  ): Promise<RepositoryRefreshClaim> {
    const cooldownStart = new Date(now.getTime() - cooldownSeconds * 1000);
    const claimed = await this.db
      .update(schema.githubInstallations)
      .set({ repositoriesRefreshedAt: now })
      .where(
        and(
          eq(schema.githubInstallations.id, installationRowId),
          or(
            isNull(schema.githubInstallations.repositoriesRefreshedAt),
            lte(schema.githubInstallations.repositoriesRefreshedAt, cooldownStart),
          ),
        ),
      )
      .returning({ id: schema.githubInstallations.id });
    if (claimed.length > 0) return { claimed: true };

    const [row] = await this.db
      .select({ refreshedAt: schema.githubInstallations.repositoriesRefreshedAt })
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.id, installationRowId))
      .limit(1);
    return { claimed: false, retryAfterSeconds: refreshRetryAfterSeconds(row?.refreshedAt ?? null, now, cooldownSeconds) };
  }

  /**
   * The Doxa users who share at least one team with this user: the only
   * users an installation can move to.
   */
  async listOwnerTransferTargets(userId: string): Promise<GitHubInstallationTransferTargetDto[]> {
    const ownMember = alias(schema.teamMembers, "own_member");
    const own = this.db
      .select({ teamId: ownMember.teamId })
      .from(ownMember)
      .where(eq(ownMember.userId, userId));
    return this.db
      .selectDistinct({
        userId: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
      })
      .from(schema.teamMembers)
      .innerJoin(schema.user, eq(schema.teamMembers.userId, schema.user.id))
      .where(
        and(
          sql`${schema.teamMembers.teamId} in (${own})`,
          ne(schema.teamMembers.userId, userId),
        ),
      )
      .orderBy(asc(schema.user.name));
  }

  /**
   * Moves an installation to another Doxa user. Only the current owner can
   * move it, and only to a user who shares a Doxa team with them. One update
   * checks both, so a race with a team change cannot pass. The projects stay
   * with their owners.
   */
  async transferInstallationOwner(input: {
    installationRowId: string;
    fromUserId: string;
    toUserId: string;
  }): Promise<"moved" | "not_found" | "target_not_allowed"> {
    const [current] = await this.db
      .select({ userId: schema.githubInstallations.userId })
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.id, input.installationRowId))
      .limit(1);
    if (!current || current.userId !== input.fromUserId) return "not_found";
    if (input.toUserId === input.fromUserId) return "target_not_allowed";

    const fromMember = alias(schema.teamMembers, "from_member");
    const toMember = alias(schema.teamMembers, "to_member");
    const sharedTeam = this.db
      .select({ teamId: fromMember.teamId })
      .from(fromMember)
      .innerJoin(toMember, eq(fromMember.teamId, toMember.teamId))
      .where(and(eq(fromMember.userId, input.fromUserId), eq(toMember.userId, input.toUserId)));
    const moved = await this.db
      .update(schema.githubInstallations)
      .set({ userId: input.toUserId, updatedAt: new Date() })
      .where(
        and(
          eq(schema.githubInstallations.id, input.installationRowId),
          eq(schema.githubInstallations.userId, input.fromUserId),
          sql`exists (${sharedTeam})`,
        ),
      )
      .returning({ id: schema.githubInstallations.id });
    return moved.length > 0 ? "moved" : "target_not_allowed";
  }

  async recordInstallation(input: {
    userId: string;
    installationId: string;
    accountLogin: string;
    accountType: string;
  }) {
    const [installation] = await this.db
      .insert(schema.githubInstallations)
      .values({
        userId: input.userId,
        installationId: input.installationId,
        accountLogin: input.accountLogin,
        accountType: input.accountType,
      })
      .onConflictDoUpdate({
        target: schema.githubInstallations.installationId,
        set: {
          accountLogin: input.accountLogin,
          accountType: input.accountType,
          updatedAt: new Date(),
        },
        setWhere: eq(schema.githubInstallations.userId, input.userId),
      })
      .returning();

    return installation ?? null;
  }

  /**
   * Records a repository of an installation row. A repository that another
   * installation already has moves only when both installations have the
   * same Doxa owner, or the old one cannot be used any more: it is not
   * active, or it lost the repository (risk 7). Else the row stays and this
   * returns null, so the first owner's project keeps working.
   */
  async recordRepository(input: {
    installationId: string;
    githubRepoId: string;
    fullName: string;
    owner: string;
    name: string;
    defaultBranch?: string;
    isPrivate?: boolean;
  }) {
    const oldInstallation = alias(schema.githubInstallations, "old_installation");
    const newInstallation = alias(schema.githubInstallations, "new_installation");
    const mayMove = sql`exists (${this.db
      .select({ id: oldInstallation.id })
      .from(oldInstallation)
      .innerJoin(newInstallation, eq(newInstallation.id, input.installationId))
      .where(
        and(
          eq(oldInstallation.id, schema.githubRepositories.installationId),
          or(
            eq(oldInstallation.userId, newInstallation.userId),
            ne(oldInstallation.status, "active"),
          ),
        ),
      )})`;
    const [repository] = await this.db
      .insert(schema.githubRepositories)
      .values({
        installationId: input.installationId,
        githubRepoId: input.githubRepoId,
        fullName: input.fullName,
        owner: input.owner,
        name: input.name,
        defaultBranch: input.defaultBranch ?? "main",
        isPrivate: input.isPrivate ?? false,
      })
      .onConflictDoUpdate({
        target: schema.githubRepositories.githubRepoId,
        set: {
          installationId: input.installationId,
          fullName: input.fullName,
          owner: input.owner,
          name: input.name,
          defaultBranch: input.defaultBranch ?? "main",
          isPrivate: input.isPrivate ?? false,
          // The installation can read it now, so it is connected again.
          disconnectedAt: null,
          disconnectedReason: null,
          updatedAt: new Date(),
        },
        setWhere: or(
          eq(schema.githubRepositories.installationId, input.installationId),
          sql`${schema.githubRepositories.disconnectedAt} is not null`,
          mayMove,
        ),
      })
      .returning();

    return repository ?? null;
  }

  /**
   * Deletes the repositories of an installation row that are not in
   * `keepGithubRepoIds`. A project on a deleted repository loses its
   * repository link (`ON DELETE SET NULL`); the project itself stays.
   */
  async removeRepositoriesExcept(installationId: string, keepGithubRepoIds: readonly string[]): Promise<number> {
    const ofInstallation = eq(schema.githubRepositories.installationId, installationId);
    const removed = await this.db
      .delete(schema.githubRepositories)
      .where(
        keepGithubRepoIds.length === 0
          ? ofInstallation
          : and(ofInstallation, notInArray(schema.githubRepositories.githubRepoId, [...keepGithubRepoIds])),
      )
      .returning({ id: schema.githubRepositories.id });
    return removed.length;
  }

  /** A repository of one of the user's installations, to list or check its branches. */
  async getBranchTargetForUser(
    userId: string,
    githubRepositoryId: string,
  ): Promise<RepositoryBranchTarget | null> {
    const [row] = await this.branchTargetQuery()
      .from(schema.githubRepositories)
      .innerJoin(
        schema.githubInstallations,
        eq(schema.githubRepositories.installationId, schema.githubInstallations.id),
      )
      .where(
        and(
          eq(schema.githubRepositories.id, githubRepositoryId),
          eq(schema.githubInstallations.userId, userId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** The project's repository, with its GitHub default branch (not the production branch). */
  async getBranchTargetForProject(projectId: string): Promise<RepositoryBranchTarget | null> {
    const [row] = await this.branchTargetQuery()
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
    return row ?? null;
  }

  private branchTargetQuery() {
    return this.db.select({
      externalId: schema.githubRepositories.githubRepoId,
      owner: schema.githubRepositories.owner,
      name: schema.githubRepositories.name,
      installationId: schema.githubInstallations.installationId,
      defaultBranch: schema.githubRepositories.defaultBranch,
    });
  }

  async getGenerationContext(projectId: string): Promise<GenerationContext | null> {
    const [row] = await this.db
      .select({
        projectId: schema.projects.id,
        projectName: schema.projects.name,
        projectSlug: schema.projects.slug,
        siteId: schema.docsSites.id,
        siteSlug: schema.docsSites.slug,
        repositoryId: schema.githubRepositories.id,
        repositoryFullName: schema.githubRepositories.fullName,
        repositoryDefaultBranch: productionBranchSql(),
        installationId: schema.githubInstallations.installationId,
      })
      .from(schema.projects)
      .innerJoin(schema.docsSites, eq(schema.projects.id, schema.docsSites.projectId))
      .innerJoin(schema.githubRepositories, eq(schema.projects.githubRepositoryId, schema.githubRepositories.id))
      .innerJoin(
        schema.githubInstallations,
        eq(schema.githubRepositories.installationId, schema.githubInstallations.id),
      )
      .where(eq(schema.projects.id, projectId))
      .limit(1);

    if (!row) return null;

    return {
      project: {
        id: row.projectId,
        name: row.projectName,
        slug: row.projectSlug,
        siteId: row.siteId,
        siteSlug: row.siteSlug,
      },
      repository: {
        id: row.repositoryId,
        fullName: row.repositoryFullName,
        defaultBranch: row.repositoryDefaultBranch,
        installationId: row.installationId,
      },
    };
  }

  async getProductionSource(
    projectId: string,
  ): Promise<ProductionGenerationSourceContext | null> {
    const [row] = await this.db
      .select({
        externalId: schema.githubRepositories.githubRepoId,
        owner: schema.githubRepositories.owner,
        name: schema.githubRepositories.name,
        defaultBranch: productionBranchSql(),
        installationId:
          schema.githubInstallations.installationId,
      })
      .from(schema.projects)
      .innerJoin(
        schema.githubRepositories,
        eq(
          schema.projects.githubRepositoryId,
          schema.githubRepositories.id,
        ),
      )
      .innerJoin(
        schema.githubInstallations,
        eq(
          schema.githubRepositories.installationId,
          schema.githubInstallations.id,
        ),
      )
      .where(eq(schema.projects.id, projectId))
      .limit(1);

    return row ?? null;
  }
}

/** Seconds until the cooldown of the last refresh ends; at least 1. */
export function refreshRetryAfterSeconds(lastRefreshAt: Date | null, now: Date, cooldownSeconds: number): number {
  if (!lastRefreshAt) return cooldownSeconds;
  const endsAt = lastRefreshAt.getTime() + cooldownSeconds * 1000;
  return Math.max(1, Math.ceil((endsAt - now.getTime()) / 1000));
}
