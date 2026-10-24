import type { ProjectDto } from "@doxahq/contracts";
import { ROLE_CAPABILITIES, type TeamRole } from "@doxahq/contracts/teams";
import { z } from "zod";
import type { Env } from "../../env";
import { toProjectId, toUserId, type Actor, type UserId } from "./actor";
import type { Capability } from "./capabilities";
import {
  decideProjectAccess,
  isProjectInScope,
  type AccessDecision,
  type ProjectAccessPolicy,
} from "./project-access-policy";
import { ProjectAccessRepository } from "./project-access-repository";

/** What the store knows about one project and one principal. */
export interface ProjectAccessRecord {
  /** `projects.user_id`: storage, billing and GitHub stay with this user. */
  readonly ownerUserId: string;
  /** Null for a personal project. */
  readonly teamId: string | null;
  /** The principal's role in the project's team; null when not a member. */
  readonly memberRole: TeamRole | null;
}

export interface ProjectAccessStore {
  /** Null when the project does not exist. */
  findAccess(projectId: string, userId: string): Promise<ProjectAccessRecord | null>;
  /** Personal projects the user owns, and the projects of the user's teams. */
  listAccessibleProjects(userId: string): Promise<ProjectDto[]>;
}

const NOT_FOUND: AccessDecision = { allowed: false, reason: "not_found" };

const projectIdSchema = z.uuid();

/**
 * v2 spec §5. The first term of the access formula is the principal's role:
 * a personal project gives its owner the `owner` role (the v1 policy); a
 * team project gives each member the role of their membership. Anyone else
 * gets `not_found`, so a denial never reveals that a project exists.
 */
export class MembershipProjectAccessPolicy implements ProjectAccessPolicy {
  constructor(private readonly store: ProjectAccessStore) {}

  static fromEnv(env: Env): MembershipProjectAccessPolicy {
    return new MembershipProjectAccessPolicy(new ProjectAccessRepository(env));
  }

  async authorize(
    actor: Actor,
    projectId: string,
    capability: Capability,
  ): Promise<AccessDecision> {
    // A malformed ID cannot name a project; answer like any unknown project.
    if (!projectIdSchema.safeParse(projectId).success) return NOT_FOUND;
    const record = await this.store.findAccess(projectId, actor.principal.userId);
    const role = record === null ? null : roleOf(record, actor.principal.userId);
    if (record === null || role === null) return NOT_FOUND;
    return decideProjectAccess(
      {
        projectId: toProjectId(projectId),
        ownerUserId: toUserId(record.ownerUserId),
        role,
        capabilities: ROLE_CAPABILITIES[role],
      },
      actor,
      capability,
    );
  }

  async listAccessibleProjects(actor: Actor): Promise<ProjectDto[]> {
    const projects = await this.store.listAccessibleProjects(actor.principal.userId);
    const { channel } = actor;
    if (channel.kind === "dashboard") return projects;
    return projects.filter((project) =>
      isProjectInScope(channel.projectScope, toProjectId(project.id)),
    );
  }
}

/**
 * The principal's role on the project, or null for no access. In a team
 * project only the membership counts: a project owner who left the team has
 * no access, as for any member who left.
 */
export function roleOf(record: ProjectAccessRecord, userId: UserId | string): TeamRole | null {
  if (record.teamId === null) return record.ownerUserId === userId ? "owner" : null;
  return record.memberRole;
}
