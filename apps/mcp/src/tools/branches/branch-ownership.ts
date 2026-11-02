import { isCreatedByAgent } from "@doxahq/api/repositories/docs-branch-records";
import type { AuthorizedProject } from "@doxahq/api/services/agent-access/project-access-policy";
import { DocsContentError } from "@doxahq/api/services/docs-content/errors";
import { HintedToolError } from "../../errors";
import type { ToolContext } from "../../tool-definition";
import { requireNamedBranch } from "../shared";
import { agentIdentity } from "./branch-view";

/** Appended to the description of every tool that changes a branch. */
export const OWN_BRANCH_ONLY =
  "Only a branch that this connection created with create_branch for the same user is accepted.";

/**
 * The branch ID, when the agent may change that branch (SEC-028, owner
 * decision 2026-10-31): only a branch that its own OAuth client created for
 * the same member. A branch from the dashboard, from another agent or from
 * another member answers not found, as delete_branch does, so an injected
 * agent cannot slip changes into a branch that a person publishes.
 */
export async function requireOwnBranch(
  context: ToolContext,
  authorized: AuthorizedProject,
  branch: string,
): Promise<string> {
  const branchId = requireNamedBranch(branch);
  const { branches } = await context.services.branches.list({
    userId: authorized.ownerUserId,
    projectId: authorized.projectId,
  });
  const target = branches.find((candidate) => candidate.id === branchId);
  if (target?.kind === "named" && isCreatedByAgent(target.createdBy, agentIdentity(context.actor))) {
    return branchId;
  }
  throw new HintedToolError(
    new DocsContentError("branch_not_found", "Branch not found."),
    "Agents change only the branches they created. Call create_branch, then pass its ID as branch.",
  );
}
