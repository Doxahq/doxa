import { generationDetailSchema, jobEventSchema } from "@doxahq/contracts";
import { z } from "zod";
import { toGenerationLog } from "@doxahq/api/services/generation-log";
import { ToolNotFoundError } from "../../errors";
import { defineMcpTool } from "../../tool-definition";
import { projectIdInput, READ_ONLY_ANNOTATIONS } from "../shared";

const RECENT_EVENT_COUNT = 20;

const recentEventSchema = jobEventSchema
  .pick({
    sequence: true,
    source: true,
    type: true,
    message: true,
    createdAt: true,
  })
  .strict();

export const getGenerationTool = defineMcpTool({
  name: "get_generation",
  title: "Get generation",
  description:
    "Returns one docs generation of a project: its status, source commit, deployment, and its most recent progress events.",
  scope: "projects:read",
  cost: "read",
  annotations: READ_ONLY_ANNOTATIONS,
  input: z
    .object({
      projectId: projectIdInput,
      generationId: z.uuid().describe("The generation ID, from get_project."),
    })
    .strict(),
  output: z
    .object({
      generation: generationDetailSchema,
      recentEvents: z.array(recentEventSchema).max(RECENT_EVENT_COUNT),
    })
    .strict(),
  async run(context, input) {
    const authorized = await context.authorize(
      input.projectId,
      "generation.read",
    );
    const { generations } = context.services;
    const generation = await generations.getDetail({
      userId: authorized.ownerUserId,
      projectId: authorized.projectId,
      jobId: input.generationId,
    });
    if (!generation)
      throw new ToolNotFoundError(
        "Generation",
        "Call get_project to see the latest generation.",
      );
    const events = toGenerationLog(await generations.listEvents(generation.id));
    return {
      generation,
      recentEvents: events
        .slice(-RECENT_EVENT_COUNT)
        .map(({ sequence, source, type, message, createdAt }) => ({
          sequence,
          source,
          type,
          message,
          createdAt,
        })),
    };
  },
});
