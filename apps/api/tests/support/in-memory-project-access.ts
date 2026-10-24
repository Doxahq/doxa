import type { ProjectDto } from "@doxahq/contracts";
import type { TeamRole } from "@doxahq/contracts/teams";
import {
  MembershipProjectAccessPolicy,
  roleOf,
  type ProjectAccessRecord,
  type ProjectAccessStore,
} from "../../src/services/agent-access/membership-project-access-policy";

export interface ProjectFixture {
  readonly owner: string;
  /** Null or missing for a personal project. */
  readonly teamId?: string | null;
}

/** Same semantics as the Drizzle store: membership decides team projects. */
export class InMemoryProjectAccess implements ProjectAccessStore {
  readonly projects: Map<string, ProjectFixture>;
  /** teamId -> userId -> role */
  readonly members = new Map<string, Map<string, TeamRole>>();

  constructor(
    projects: Record<string, ProjectFixture>,
    members: Record<string, Record<string, TeamRole>> = {},
    private readonly toProject: (projectId: string, teamId: string | null) => ProjectDto = fixtureProject,
  ) {
    this.projects = new Map(Object.entries(projects));
    for (const [teamId, roles] of Object.entries(members)) {
      this.members.set(teamId, new Map(Object.entries(roles)));
    }
  }

  join(teamId: string, userId: string, role: TeamRole): void {
    const team = this.members.get(teamId) ?? new Map<string, TeamRole>();
    team.set(userId, role);
    this.members.set(teamId, team);
  }

  leave(teamId: string, userId: string): void {
    this.members.get(teamId)?.delete(userId);
  }

  moveToTeam(projectId: string, teamId: string): void {
    const project = this.projects.get(projectId);
    if (project) this.projects.set(projectId, { ...project, teamId });
  }

  async findAccess(projectId: string, userId: string): Promise<ProjectAccessRecord | null> {
    return this.record(projectId, userId);
  }

  async listAccessibleProjects(userId: string): Promise<ProjectDto[]> {
    return [...this.projects.keys()]
      .filter((projectId) => {
        const record = this.record(projectId, userId);
        return record !== null && roleOf(record, userId) !== null;
      })
      .map((projectId) => this.toProject(projectId, this.projects.get(projectId)?.teamId ?? null));
  }

  private record(projectId: string, userId: string): ProjectAccessRecord | null {
    const project = this.projects.get(projectId);
    if (!project) return null;
    const teamId = project.teamId ?? null;
    return {
      ownerUserId: project.owner,
      teamId,
      memberRole: teamId === null ? null : (this.members.get(teamId)?.get(userId) ?? null),
    };
  }
}

export function fixtureProject(id: string, teamId: string | null = null): ProjectDto {
  return {
    id,
    name: `Project ${id.slice(0, 4)}`,
    slug: `project-${id.slice(0, 4)}`,
    githubRepositoryId: null,
    repositoryFullName: null,
    publishedVersionId: null,
    docsUrl: null,
    team: teamId === null ? null : { id: teamId, name: `Team ${teamId.slice(0, 4)}` },
  };
}

/** The real policy over fixed projects and memberships. */
export function membershipPolicy(
  projects: Record<string, ProjectFixture>,
  members: Record<string, Record<string, TeamRole>> = {},
): MembershipProjectAccessPolicy {
  return new MembershipProjectAccessPolicy(new InMemoryProjectAccess(projects, members));
}
