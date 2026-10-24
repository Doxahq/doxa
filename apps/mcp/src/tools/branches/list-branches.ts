import { z } from "zod";
import { defineMcpTool } from "../../tool-definition";
import { projectIdInput, READ_ONLY_ANNOTATIONS } from "../shared";
import { agentBranchOutput, toAgentBranchView } from "./branch-view";

export const listBranchesTool = defineMcpTool({
  name: "list_branches",
  title: "List branches",
  description:
    'Lists the docs branches of a project with each branch\'s ID, name, revision, change count, and creator, plus the branch limit of the site. createdBy is { kind: "user" } for a branch from the dashboard, or { kind: "agent", clientName, isCaller } for an agent branch. delete_branch works only where isCaller is true.',
  scope: "docs:read",
  cost: "read",
  annotations: READ_ONLY_ANNOTATIONS,
  input: z.object({ projectId: projectIdInput }).strict(),
  output: z
    .object({
      branches: z.array(agentBranchOutput),
      maxBranchesPerSite: z.number().int().positive(),
    })
    .strict(),
  async run(context, input) {
    const authorized = await context.authorize(input.projectId, "docs.read");
    const list = await context.services.branches.list({
      userId: authorized.ownerUserId,
      projectId: authorized.projectId,
    });
    return {
      branches: list.branches.flatMap((branch) =>
        branch.kind === "named" ? [toAgentBranchView(branch, context.actor)] : [],
      ),
      maxBranchesPerSite: list.maxBranchesPerSite,
    };
  },
});
