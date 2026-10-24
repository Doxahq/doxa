import { desc, eq } from "drizzle-orm";
import { createDb, schema } from "@doxahq/db";
import type { GenerationContext, GitHubRepositoryDto } from "@doxahq/contracts";
import type { Env } from "../env";

export interface ProductionGenerationSourceContext {
  externalId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  installationId: string;
}

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
          userId: input.userId,
          accountLogin: input.accountLogin,
          accountType: input.accountType,
          updatedAt: new Date(),
        },
      })
      .returning();

    return installation;
  }

  async recordRepository(input: {
    installationId: string;
    githubRepoId: string;
    fullName: string;
    owner: string;
    name: string;
    defaultBranch?: string;
    isPrivate?: boolean;
  }) {
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
          updatedAt: new Date(),
        },
      })
      .returning();

    return repository;
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
        repositoryDefaultBranch: schema.githubRepositories.defaultBranch,
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
        defaultBranch: schema.githubRepositories.defaultBranch,
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
