import { generationJobSchema, projectSchema } from "@doxahq/contracts";
import { z } from "zod";
import { AccessDeniedError } from "../../errors";
import { defineMcpTool } from "../../tool-definition";
import { projectIdInput, READ_ONLY_ANNOTATIONS } from "../shared";

export const getProjectTool = defineMcpTool({
  name: "get_project",
  title: "Get project",
  description:
    "Returns one project: its name, slug, connected repository, live docs URL, and latest generation.",
  scope: "projects:read",
  cost: "read",
  annotations: READ_ONLY_ANNOTATIONS,
  input: z.object({ projectId: projectIdInput }).strict(),
  output: z
    .object({
      project: projectSchema,
      latestGeneration: generationJobSchema.nullable(),
    })
    .strict(),
  async run(context, input) {
    const authorized = await context.authorize(input.projectId, "project.read");
    const { projects } = context.services;
    const project = await projects.getForUser(
      authorized.ownerUserId,
      authorized.projectId,
    );
    // The policy saw the project a moment ago; it was deleted since.
    if (!project) throw new AccessDeniedError("not_found");
    const [withUrl] = await projects.withDocsUrls([project]);
    return {
      project: withUrl ?? project,
      latestGeneration: await projects.latestGeneration(authorized.projectId),
    };
  },
});
