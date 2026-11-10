import { z } from "zod";
import { generationStartAction } from "@doxahq/api/services/agent-actions/actions/generation-start";
import { additiveActionAnnotations, defineActionTool } from "../action-tool";
import { projectIdInput } from "../shared";

export const startGenerationTool = defineActionTool({
  name: "start_generation",
  title: "Start a generation",
  description:
    "Starts writing the docs from the connected GitHub repository. The generated docs go live when the run completes. Follow it with get_generation.",
  action: "generation.start",
  liveActivityKind: "generation",
  scope: "generation:run",
  annotations: additiveActionAnnotations,
  input: z
    .object({
      projectId: projectIdInput,
      force: z.boolean().default(false).describe("Run even when the source did not change."),
    })
    .strict(),
  result: generationStartAction.resultSchema,
  toCall: (input) => ({ projectId: input.projectId, payload: { force: input.force } }),
});
