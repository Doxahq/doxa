import { MAX_APPROVAL_TEXT_LENGTH } from "@doxahq/contracts/approval-requests";
import { z } from "zod";
import { docsRestoreAction } from "@doxahq/api/services/agent-actions/actions/docs-restore";
import { defineActionTool, destructiveActionAnnotations } from "../action-tool";
import { projectIdInput } from "../shared";

export const restorePublicationTool = defineActionTool({
  name: "restore_publication",
  title: "Restore a publication",
  description: "Rolls the live site back to an earlier publication from list_publications.",
  action: "docs.restore",
  liveActivityKind: "publish",
  scope: "publish",
  annotations: destructiveActionAnnotations,
  input: z
    .object({
      projectId: projectIdInput,
      publicationId: z.uuid().describe("The publication to restore, from list_publications."),
      summary: z.string().trim().max(MAX_APPROVAL_TEXT_LENGTH).optional().describe("Why to roll back."),
    })
    .strict(),
  result: docsRestoreAction.resultSchema,
  toCall: (input) => ({
    projectId: input.projectId,
    payload: { publicationId: input.publicationId },
    summary: input.summary ?? null,
  }),
});
