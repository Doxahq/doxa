import type { ProjectDto } from "@doxahq/contracts";
import { and, eq } from "drizzle-orm";
import { createDb, schema } from "@doxahq/db";
import type { Env } from "../../env";
import { ProjectsRepository } from "../../repositories/projects";
import type {
  ProjectAccessRecord,
  ProjectAccessStore,
} from "./membership-project-access-policy";

export class ProjectAccessRepository implements ProjectAccessStore {
  private readonly db;
  private readonly projects: ProjectsRepository;

  constructor(env: Env) {
    this.db = createDb(env);
    this.projects = new ProjectsRepository(env);
  }

  /** One query: the project's owner and team, and the user's role in that team. */
  async findAccess(projectId: string, userId: string): Promise<ProjectAccessRecord | null> {
    const [row] = await this.db
      .select({
        ownerUserId: schema.projects.userId,
        teamId: schema.projects.teamId,
        memberRole: schema.teamMembers.role,
      })
      .from(schema.projects)
      .leftJoin(
        schema.teamMembers,
        and(
          eq(schema.teamMembers.teamId, schema.projects.teamId),
          eq(schema.teamMembers.userId, userId),
        ),
      )
      .where(eq(schema.projects.id, projectId))
      .limit(1);
    return row ?? null;
  }

  listAccessibleProjects(userId: string): Promise<ProjectDto[]> {
    return this.projects.listAccessibleForUser(userId);
  }
}
