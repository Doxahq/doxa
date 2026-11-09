import type { ProjectScopeClaim } from "@doxahq/contracts/agent-access";
import type { ValidationIssue } from "@doxahq/contracts/validation";
import { dashboardActor } from "../agent-access/actor";
import type { ProjectAccessPolicy } from "../agent-access/project-access-policy";

/** A person can approve only what the agent asked for. */
export function scopeIssues(
  approved: readonly string[],
  offered: readonly string[],
): ValidationIssue[] {
  return approved.flatMap((scope, index) =>
    offered.includes(scope)
      ? []
      : [issue(`/scopes/${index}`, `The agent did not request the ${scope} scope.`)],
  );
}

/** A person can give an agent only the projects that the person can read. */
export async function projectScopeIssues(
  projects: ProjectAccessPolicy,
  userId: string,
  projectScope: ProjectScopeClaim,
): Promise<ValidationIssue[]> {
  if (projectScope.kind === "all") return [];
  const actor = dashboardActor(userId);
  const decisions = await Promise.all(
    projectScope.projectIds.map((id) => projects.authorize(actor, id, "project.read")),
  );
  return decisions.flatMap((decision, index) =>
    decision.allowed
      ? []
      : [issue(`/projectScope/projectIds/${index}`, "The project was not found.")],
  );
}

function issue(path: string, message: string): ValidationIssue {
  return { path, code: "unknown_key", severity: "error", message };
}
