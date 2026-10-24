import { docsBranchStatusSchema } from "@doxahq/contracts/docs-branches";
import { z } from "zod";
import { defineMcpTool } from "../../tool-definition";
import { branchInput, projectIdInput, READ_ONLY_ANNOTATIONS } from "../shared";

export const getBranchStatusTool = defineMcpTool({
  name: "get_branch_status",
  title: "Get branch status",
  description:
    "Returns the revision of a branch and whether main published a new version since the branch started. Call it before an edit to learn the current revision.",
  scope: "docs:read",
  cost: "read",
  annotations: READ_ONLY_ANNOTATIONS,
  input: z.object({ projectId: projectIdInput, branch: branchInput }).strict(),
  output: docsBranchStatusSchema,
  async run(context, input) {
    const authorized = await context.authorize(input.projectId, "docs.read");
    return context.services.branches.getStatus({
      userId: authorized.ownerUserId,
      projectId: authorized.projectId,
      branch: input.branch ?? "main",
    });
  },
});
