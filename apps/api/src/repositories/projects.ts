import { and, desc, eq, isNotNull, isNull, or } from "drizzle-orm";
import { createDb, schema } from "@doxahq/db";
import type { ProjectDto } from "@doxahq/contracts";
import type { Env } from "../env";
import { siteUploadsBusy } from "../services/site-assets/upload-busy-errors";
import { runWithSiteLock, SITE_LOCK_BUSY, SITE_LOCKS } from "./site-advisory-lock";
import {
  createDocsNamespaceLookup,
  isHostnameAvailable,
  type DocsNamespaceCandidate,
} from "../services/docs-namespace";
import { createGeneratedDocsHostname } from "../utils/docs-url";
import { ensureSlug } from "../utils/slug";

type DocsNamespaceAvailability = (
  candidate: DocsNamespaceCandidate,
) => Promise<boolean>;

export type CreateProjectErrorCode =
  | "repository_not_found"
  | "repository_project_exists"
  | "repository_already_connected"
  | "project_not_found"
  | "slug_unavailable"
  | "branch_not_found"
  | "branch_check_unavailable";

export class CreateProjectError extends Error {
  constructor(
    readonly code: CreateProjectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CreateProjectError";
  }
}

const MAX_SLUG_ATTEMPTS = 50;

const SITE_ASSET_LOCK_DEADLINE_MS = 15_000;

function withinDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(siteUploadsBusy()), SITE_ASSET_LOCK_DEADLINE_MS);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export class ProjectsRepository {
  private readonly db;
  private readonly docsBaseDomain: string | undefined;

  constructor(env: Env) {
    this.db = createDb(env);
    this.docsBaseDomain = env.DOCS_BASE_DOMAIN;
  }

  /**
   * A transaction only carries the lock: R2 holds the files. The deadline
   * frees the lock if a storage call stalls, because the storage client has
   * no timeout of its own.
   */
  async withSiteAssetLock<T>(siteId: string, work: () => Promise<T>): Promise<T> {
    const result = await runWithSiteLock(this.db, SITE_LOCKS.siteAssetUploads, siteId, () =>
      withinDeadline(work()),
    );
    if (result === SITE_LOCK_BUSY) throw siteUploadsBusy();
    return result;
  }

  async getDocsSiteForUser(
    userId: string,
    projectId: string,
  ): Promise<{ siteId: string } | null> {
    const [site] = await this.db
      .select({ siteId: schema.docsSites.id })
      .from(schema.projects)
      .innerJoin(
        schema.docsSites,
        eq(schema.projects.id, schema.docsSites.projectId),
      )
      .where(
        and(
          eq(schema.projects.userId, userId),
          eq(schema.projects.id, projectId),
        ),
      )
      .limit(1);
    return site ?? null;
  }

  /**
   * The projects a user can open: personal projects they own, and the
   * projects of every team they belong to. A team project counts only
   * through the membership, also for its owner (v2 spec §5).
   */
  async listAccessibleForUser(userId: string): Promise<ProjectDto[]> {
    const rows = await this.db
      .select(projectColumns)
      .from(schema.projects)
      .leftJoin(
        schema.docsSites,
        eq(schema.projects.id, schema.docsSites.projectId),
      )
      .leftJoin(schema.teams, eq(schema.teams.id, schema.projects.teamId))
      .leftJoin(
        schema.githubRepositories,
        eq(schema.githubRepositories.id, schema.projects.githubRepositoryId),
      )
      .leftJoin(
        schema.teamMembers,
        and(
          eq(schema.teamMembers.teamId, schema.projects.teamId),
          eq(schema.teamMembers.userId, userId),
        ),
      )
      .where(
        or(
          and(
            isNull(schema.projects.teamId),
            eq(schema.projects.userId, userId),
          ),
          isNotNull(schema.teamMembers.userId),
        ),
      )
      .orderBy(desc(schema.projects.createdAt));

    return rows.map(toListedProject);
  }

  /**
   * Owner-scoped: callers pass the project owner's ID, which they got from
   * the access policy. It never authorizes a team member on its own.
   */
  async getForUser(
    userId: string,
    projectId: string,
  ): Promise<ProjectDto | null> {
    const [row] = await this.db
      .select(projectColumns)
      .from(schema.projects)
      .leftJoin(
        schema.docsSites,
        eq(schema.projects.id, schema.docsSites.projectId),
      )
      .leftJoin(schema.teams, eq(schema.teams.id, schema.projects.teamId))
      .leftJoin(
        schema.githubRepositories,
        eq(schema.githubRepositories.id, schema.projects.githubRepositoryId),
      )
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.userId, userId),
        ),
      )
      .limit(1);

    return row ? toListedProject(row) : null;
  }

  async getInternal(projectId: string) {
    const [row] = await this.db
      .select({
        id: schema.projects.id,
        name: schema.projects.name,
        slug: schema.projects.slug,
        githubRepositoryId: schema.projects.githubRepositoryId,
        siteId: schema.docsSites.id,
        siteSlug: schema.docsSites.slug,
      })
      .from(schema.projects)
      .innerJoin(
        schema.docsSites,
        eq(schema.projects.id, schema.docsSites.projectId),
      )
      .where(eq(schema.projects.id, projectId))
      .limit(1);

    return row ?? null;
  }

  /**
   * `productionBranch` must already be checked on GitHub
   * (`services/project-production-branch.ts`). Left out, the project follows
   * the repository's default branch.
   */
  async createForRepository(input: {
    userId: string;
    githubRepositoryId: string;
    name?: string;
    slug?: string;
    productionBranch?: string;
  }): Promise<ProjectDto> {
    const repo = await this.getOwnedUnusedRepository(
      input.userId,
      input.githubRepositoryId,
    );
    const { project } = await this.insertProject({
      userId: input.userId,
      repository: repo,
      name: input.name ?? repo.name,
      baseSlug: ensureSlug(input.slug ?? repo.name, repo.name),
      productionBranch: input.productionBranch ?? null,
    });
    return project;
  }

  /** Creates a project with no repository. Its docs site starts empty. */
  async createWithoutRepository(input: {
    userId: string;
    name: string;
    slug?: string;
  }): Promise<{ project: ProjectDto; siteId: string }> {
    return this.insertProject({
      userId: input.userId,
      repository: null,
      name: input.name,
      baseSlug: ensureSlug(input.slug ?? input.name, "docs"),
      productionBranch: null,
    });
  }

  /**
   * Links a repository to a project that has none. A branch chosen for an
   * earlier repository does not carry over: `productionBranch` replaces it.
   */
  async connectRepository(input: {
    userId: string;
    projectId: string;
    githubRepositoryId: string;
    productionBranch?: string;
  }): Promise<ProjectDto> {
    const project = await this.getForUser(input.userId, input.projectId);
    if (!project) {
      throw new CreateProjectError("project_not_found", "Project not found.");
    }
    if (project.githubRepositoryId) {
      throw new CreateProjectError(
        "repository_already_connected",
        "This project already has a connected repository.",
      );
    }
    const repo = await this.getOwnedUnusedRepository(
      input.userId,
      input.githubRepositoryId,
    );
    const [updated] = await this.db
      .update(schema.projects)
      .set({
        githubRepositoryId: repo.id,
        productionBranch: input.productionBranch ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.projects.id, project.id),
          eq(schema.projects.userId, input.userId),
          isNull(schema.projects.githubRepositoryId),
        ),
      )
      .returning({ id: schema.projects.id });
    if (!updated) {
      throw new CreateProjectError(
        "repository_already_connected",
        "This project already has a connected repository.",
      );
    }
    return {
      ...project,
      githubRepositoryId: repo.id,
      repositoryFullName: repo.fullName,
    };
  }

  private async getOwnedUnusedRepository(
    userId: string,
    githubRepositoryId: string,
  ) {
    const [repo] = await this.db
      .select({
        fullName: schema.githubRepositories.fullName,
        id: schema.githubRepositories.id,
        name: schema.githubRepositories.name,
      })
      .from(schema.githubRepositories)
      .innerJoin(
        schema.githubInstallations,
        eq(
          schema.githubRepositories.installationId,
          schema.githubInstallations.id,
        ),
      )
      .where(
        and(
          eq(schema.githubRepositories.id, githubRepositoryId),
          eq(schema.githubInstallations.userId, userId),
        ),
      )
      .limit(1);

    if (!repo) {
      throw new CreateProjectError(
        "repository_not_found",
        "GitHub repository not found.",
      );
    }

    const existingProject = await this.getForUserRepository(userId, repo.id);
    if (existingProject) {
      throw new CreateProjectError(
        "repository_project_exists",
        `A project already exists for ${repo.fullName}: ${existingProject.name}.`,
      );
    }
    return repo;
  }

  private async insertProject(input: {
    userId: string;
    repository: { id: string; fullName: string } | null;
    name: string;
    baseSlug: string;
    productionBranch: string | null;
  }): Promise<{ project: ProjectDto; siteId: string }> {
    return this.db.transaction(async (tx) => {
      const docsNamespace = createDocsNamespaceLookup(tx);
      const slug = await createAvailableSlug(
        input.baseSlug,
        (candidate) => isHostnameAvailable(docsNamespace, candidate),
        this.docsBaseDomain,
      );
      const [project] = await tx
        .insert(schema.projects)
        .values({
          userId: input.userId,
          githubRepositoryId: input.repository?.id ?? null,
          productionBranch: input.productionBranch,
          name: input.name,
          slug,
        })
        .returning();

      const [site] = await tx
        .insert(schema.docsSites)
        .values({
          projectId: project.id,
          slug: project.slug,
        })
        .returning({ id: schema.docsSites.id });

      return {
        project: toProjectDto(project, input.repository?.fullName ?? null),
        siteId: site.id,
      };
    });
  }

  private async getForUserRepository(
    userId: string,
    githubRepositoryId: string,
  ): Promise<ProjectDto | null> {
    const [row] = await this.db
      .select({
        id: schema.projects.id,
        name: schema.projects.name,
        slug: schema.projects.slug,
        githubRepositoryId: schema.projects.githubRepositoryId,
        repositoryFullName: schema.githubRepositories.fullName,
        publishedVersionId: schema.docsSites.publishedVersionId,
      })
      .from(schema.projects)
      .leftJoin(
        schema.docsSites,
        eq(schema.projects.id, schema.docsSites.projectId),
      )
      .leftJoin(
        schema.githubRepositories,
        eq(schema.githubRepositories.id, schema.projects.githubRepositoryId),
      )
      .where(
        and(
          eq(schema.projects.userId, userId),
          eq(schema.projects.githubRepositoryId, githubRepositoryId),
        ),
      )
      .orderBy(desc(schema.projects.createdAt))
      .limit(1);

    return row ? { ...row, docsUrl: null, team: null } : null;
  }
}

export async function createAvailableSlug(
  baseSlug: string,
  isAvailable: DocsNamespaceAvailability,
  docsBaseDomain: string | undefined,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
    const hostname = createGeneratedDocsHostname(slug, docsBaseDomain);
    if (await isAvailable({ label: slug, hostname })) return slug;
  }

  throw new CreateProjectError(
    "slug_unavailable",
    "Could not create a unique project slug. Try a different project name.",
  );
}

function toProjectDto(
  project: typeof schema.projects.$inferSelect,
  repositoryFullName: string | null,
): ProjectDto {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    githubRepositoryId: project.githubRepositoryId,
    repositoryFullName,
    publishedVersionId: null,
    docsUrl: null,
    team: null,
  };
}

const projectColumns = {
  id: schema.projects.id,
  name: schema.projects.name,
  slug: schema.projects.slug,
  githubRepositoryId: schema.projects.githubRepositoryId,
  repositoryFullName: schema.githubRepositories.fullName,
  publishedVersionId: schema.docsSites.publishedVersionId,
  teamId: schema.teams.id,
  teamName: schema.teams.name,
};

function toListedProject(row: {
  id: string;
  name: string;
  slug: string;
  githubRepositoryId: string | null;
  repositoryFullName: string | null;
  publishedVersionId: string | null;
  teamId: string | null;
  teamName: string | null;
}): ProjectDto {
  const { teamId, teamName, ...project } = row;
  return {
    ...project,
    docsUrl: null,
    team:
      teamId !== null && teamName !== null ? { id: teamId, name: teamName } : null,
  };
}
