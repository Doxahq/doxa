import { MAX_APPROVAL_TEXT_LENGTH } from "@doxahq/contracts/approval-requests";
import { z } from "zod";
import { docsPublishAction } from "@doxahq/api/services/agent-actions/actions/docs-publish";
import { defineActionTool, destructiveActionAnnotations } from "../action-tool";
import { projectIdInput } from "../shared";

export const publishBranchTool = defineActionTool({
  name: "publish_branch",
  title: "Publish a branch",
  description:
    "Publishes a named branch to the live site. The user reviews the changes in the Doxa dashboard before they go live.",
  action: "docs.publish",
  liveActivityKind: "publish",
  scope: "publish",
  annotations: destructiveActionAnnotations,
  input: z
    .object({
      projectId: projectIdInput,
      branchId: z.uuid().describe("The branch to publish, from create_branch or list_branches."),
      summary: z
        .string()
        .trim()
        .min(1)
        .max(MAX_APPROVAL_TEXT_LENGTH)
        .describe("What changed and why, in one or two sentences. The reviewer reads it."),
      eraseBranch: z
        .boolean()
        .default(false)
        .describe("Delete the branch after the publish. The user can change this choice when they approve."),
    })
    .strict(),
  result: docsPublishAction.resultSchema,
  toCall: (input) => ({
    projectId: input.projectId,
    payload: { branchId: input.branchId, eraseBranch: input.eraseBranch },
    summary: input.summary,
  }),
});
