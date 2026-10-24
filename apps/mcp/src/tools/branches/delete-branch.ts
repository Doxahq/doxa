import { z } from "zod";
import { defineMcpTool } from "../../tool-definition";
import { agentIdentity } from "./branch-view";
import {
  namedBranchInput,
  projectIdInput,
  requireNamedBranch,
} from "../shared";

export const deleteBranchTool = defineMcpTool({
  name: "delete_branch",
  title: "Delete branch",
  description:
    "Deletes a branch that this connection created with create_branch for the same user, with all its unpublished changes. Use it to clean up after a publish or an abandoned task. Branches of the user, of other agents, or of other team members answer not found. A branch with a pending publish request is kept: cancel the request with cancel_approval_request first. A branch is never live, so the delete needs no approval.",
  scope: "docs:write",
  cost: "write",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  input: z
    .object({ projectId: projectIdInput, branch: namedBranchInput })
    .strict(),
  output: z.object({ deletedBranchId: z.uuid() }).strict(),
  async run(context, input) {
    const branchId = requireNamedBranch(input.branch);
    const authorized = await context.authorize(input.projectId, "docs.write");
    await context.services.branches.deleteOwn({
      userId: authorized.ownerUserId,
      projectId: authorized.projectId,
      branchId,
      agent: agentIdentity(context.actor),
    });
    return { deletedBranchId: branchId };
  },
});
