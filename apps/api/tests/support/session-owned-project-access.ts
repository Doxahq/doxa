import type { ProjectDto } from "@doxahq/contracts";
import type { Env } from "../../src/env";
import { ProjectsRepository } from "../../src/repositories/projects";
import type {
  ProjectAccessRecord,
  ProjectAccessStore,
} from "../../src/services/agent-access/membership-project-access-policy";

/**
 * Stands in for `ProjectAccessRepository` in route tests that predate teams:
 * every project is a personal project of the requesting user, so the real
 * policy allows the route and the mocked repositories decide "not found", as
 * in v1. Team behavior has its own tests with a real membership store.
 */
export class SessionOwnedProjectAccess implements ProjectAccessStore {
  constructor(private readonly env: Env) {}

  async findAccess(_projectId: string, userId: string): Promise<ProjectAccessRecord | null> {
    return { ownerUserId: userId, teamId: null, memberRole: null };
  }

  listAccessibleProjects(userId: string): Promise<ProjectDto[]> {
    // Built on use: route tests that never list mock no database.
    return new ProjectsRepository(this.env).listAccessibleForUser(userId);
  }
}
