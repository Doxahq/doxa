import { z } from "zod";
import { generationCancelAction } from "@doxahq/api/services/agent-actions/actions/generation-cancel";
import { defineActionTool } from "../action-tool";
import { projectIdInput } from "../shared";

export const cancelGenerationTool = defineActionTool({
  name: "cancel_generation",
  title: "Cancel a generation",
  description: "Stops a running generation. The live site does not change.",
  action: "generation.cancel",
  scope: "generation:run",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z
    .object({
      projectId: projectIdInput,
      generationId: z.uuid().describe("The generation ID, from get_project or get_generation."),
    })
    .strict(),
  result: generationCancelAction.resultSchema,
  toCall: (input) => ({ projectId: input.projectId, payload: { generationId: input.generationId } }),
});
