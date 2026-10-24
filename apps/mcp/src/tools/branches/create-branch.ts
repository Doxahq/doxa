import type { CreateDocsBranchInput } from "@doxahq/contracts/docs-branches";
import { z } from "zod";
import { DocsBranchValidationError } from "@doxahq/api/services/docs-branches/management";
import { HintedToolError } from "../../errors";
import { defineMcpTool, type ToolContext } from "../../tool-definition";
import { projectIdInput, writeAnnotations } from "../shared";
import { agentBranchOutput, agentCreator, toAgentBranchView } from "./branch-view";

interface BranchOwner {
  userId: string;
  projectId: string;
}

export const createBranchTool = defineMcpTool({
  name: "create_branch",
  title: "Create branch",
  description:
    'Creates a named docs branch from main or from another branch. Make all your edits on it, then build a preview. Start the name with "agent-", for example "agent-fix-install". Names use lowercase letters, digits, and single hyphens, at most 40 characters. Only this connection can delete the branch later, with delete_branch.',
  scope: "docs:write",
  cost: "write",
  annotations: writeAnnotations(false),
  input: z
    .object({
      projectId: projectIdInput,
      name: z.string().min(1).max(64).describe("The branch name."),
      fromBranchId: z
        .uuid()
        .optional()
        .describe("Start from this branch instead of main."),
    })
    .strict(),
  output: agentBranchOutput,
  async run(context, input) {
    const authorized = await context.authorize(input.projectId, "docs.write");
    const owner = {
      userId: authorized.ownerUserId,
      projectId: authorized.projectId,
    };
    const request: CreateDocsBranchInput = {
      name: input.name,
      from: input.fromBranchId
        ? { kind: "branch", branchId: input.fromBranchId }
        : { kind: "main" },
    };
    try {
      const branch = await context.services.branches.create({
        ...owner,
        request,
        createdBy: agentCreator(context.actor),
      });
      return toAgentBranchView(branch, context.actor);
    } catch (error) {
      throw await withBranchLimitHint(context, owner, error);
    }
  },
});

/** At the limit, the agent needs the existing names to pick one to reuse. */
async function withBranchLimitHint(
  context: ToolContext,
  owner: BranchOwner,
  error: unknown,
): Promise<unknown> {
  if (!isBranchLimitError(error)) return error;
  const { branches } = await context.services.branches.list(owner);
  const names = branches.flatMap((branch) =>
    branch.kind === "named" ? [branch.name] : [],
  );
  return new HintedToolError(
    error,
    `Existing branches: ${names.join(", ")}. Reuse one of them, or ask the user to erase one in the dashboard.`,
  );
}

function isBranchLimitError(error: unknown): boolean {
  return (
    error instanceof DocsBranchValidationError &&
    error.issues.some((issue) => issue.code === "branch_limit_reached")
  );
}
