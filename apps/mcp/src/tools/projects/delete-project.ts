import { z } from "zod";
import { projectDeleteAction } from "@doxahq/api/services/agent-actions/actions/project-delete";
import { defineActionTool, destructiveActionAnnotations } from "../action-tool";
import { projectIdInput } from "../shared";

export const deleteProjectTool = defineActionTool({
  name: "delete_project",
  title: "Delete a project",
  description:
    "Deletes a project with its docs and domains. A human always approves this in the Doxa dashboard.",
  action: "project.delete",
  scope: "projects:write",
  annotations: destructiveActionAnnotations,
  input: z.object({ projectId: projectIdInput }).strict(),
  result: projectDeleteAction.resultSchema,
  toCall: (input) => ({ projectId: input.projectId, payload: {} }),
});
