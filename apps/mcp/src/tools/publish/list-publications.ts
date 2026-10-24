import { docsPublicationPageSchema } from "@doxahq/contracts/docs-branches";
import { z } from "zod";
import { defineMcpTool } from "../../tool-definition";
import {
  pageSizeInput,
  projectIdInput,
  READ_ONLY_ANNOTATIONS,
} from "../shared";

export const listPublicationsTool = defineMcpTool({
  name: "list_publications",
  title: "List publications",
  description:
    "Lists the publish history of a project, newest first: each publication's version, author, branch, summary, and whether it can be restored.",
  scope: "docs:read",
  cost: "read",
  annotations: READ_ONLY_ANNOTATIONS,
  input: z
    .object({
      projectId: projectIdInput,
      cursor: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe(
          "The nextCursor of the previous page. Omit it for the first page.",
        ),
      limit: pageSizeInput(10, 25),
    })
    .strict(),
  output: docsPublicationPageSchema,
  async run(context, input) {
    const authorized = await context.authorize(input.projectId, "docs.read");
    return context.services.publications.list({
      userId: authorized.ownerUserId,
      projectId: authorized.projectId,
      cursor: input.cursor,
      limit: input.limit,
    });
  },
});
