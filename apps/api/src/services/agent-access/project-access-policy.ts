import type { ProjectDto } from "@doxahq/contracts";
import type { TeamRole } from "@doxahq/contracts/teams";
import type { Actor, ProjectId, ProjectScope, UserId } from "./actor";
import type { Capability } from "./capabilities";
import { capabilitiesForScopes } from "./scopes";

declare const authorizedProjectBrand: unique symbol;

/**
 * Proof that a policy checked the actor against the project. The brand stops
 * other code from building one with an object literal.
 */
export interface AuthorizedProject {
  readonly [authorizedProjectBrand]: true;
  readonly projectId: ProjectId;
  readonly ownerUserId: UserId;
  /** The principal's role; `owner` for the owner of a personal project. */
  readonly role: TeamRole;
  /** Role capabilities narrowed by the grant (effective access). */
  readonly capabilities: ReadonlySet<Capability>;
}

export type AccessDenialReason =
  /** No project, or the principal has no role on it. */
  | "not_found"
  /** The grant does not have the scope. */
  | "scope_missing"
  /** The project is outside the project scope of the grant. */
  | "project_not_in_grant"
  /** A person's role lacks this capability (teams). Agents get `not_found`. */
  | "forbidden";

export type AccessDecision =
  | { readonly allowed: true; readonly project: AuthorizedProject }
  | { readonly allowed: false; readonly reason: AccessDenialReason };

export interface ProjectAccessPolicy {
  authorize(
    actor: Actor,
    projectId: string,
    capability: Capability,
  ): Promise<AccessDecision>;
  listAccessibleProjects(actor: Actor): Promise<ProjectDto[]>;
}

export function isProjectInScope(
  scope: ProjectScope,
  projectId: ProjectId,
): boolean {
  return scope.kind === "all" || scope.projectIds.has(projectId);
}

/** Spec 7.3: role capabilities, narrowed by grant scopes, emptied outside the grant. */
export function effectiveCapabilities(
  roleCapabilities: ReadonlySet<Capability>,
  actor: Actor,
  projectId: ProjectId,
): ReadonlySet<Capability> {
  const { channel } = actor;
  if (channel.kind === "dashboard") return roleCapabilities;
  if (!isProjectInScope(channel.projectScope, projectId)) return new Set();
  const granted = capabilitiesForScopes(channel.scopes);
  return new Set([...roleCapabilities].filter((c) => granted.has(c)));
}

export interface ProjectRole {
  readonly projectId: ProjectId;
  readonly ownerUserId: UserId;
  readonly role: TeamRole;
  readonly capabilities: ReadonlySet<Capability>;
}

/**
 * Shared decision for every policy once it knows the principal's role. Callers
 * resolve `not_found` themselves, before this, so a denial never reveals that
 * a project exists.
 */
export function decideProjectAccess(
  role: ProjectRole,
  actor: Actor,
  capability: Capability,
): AccessDecision {
  const { channel } = actor;
  if (
    channel.kind === "agent" &&
    !isProjectInScope(channel.projectScope, role.projectId)
  ) {
    return { allowed: false, reason: "project_not_in_grant" };
  }
  if (!role.capabilities.has(capability)) {
    // v2 spec §12 question 3: an agent sees a role denial as "not found",
    // as for a project outside its grant. A person in the dashboard knows
    // the project, so they learn that their role is the reason.
    return { allowed: false, reason: channel.kind === "agent" ? "not_found" : "forbidden" };
  }
  const capabilities = effectiveCapabilities(
    role.capabilities,
    actor,
    role.projectId,
  );
  if (!capabilities.has(capability)) {
    return { allowed: false, reason: "scope_missing" };
  }
  return {
    allowed: true,
    project: createAuthorizedProject({ ...role, capabilities }),
  };
}

// The only cast to AuthorizedProject; kept private so the brand holds.
function createAuthorizedProject(
  fields: Omit<AuthorizedProject, typeof authorizedProjectBrand>,
): AuthorizedProject {
  return fields as AuthorizedProject;
}
