import { projectSchema } from "@doxahq/contracts";
import { z } from "zod";
import { defineMcpTool } from "../../tool-definition";
import {
  cursorInput,
  nextCursorOutput,
  pageOf,
  pageSizeInput,
  READ_ONLY_ANNOTATIONS,
} from "../shared";

export const listProjectsTool = defineMcpTool({
  name: "list_projects",
  title: "List projects",
  description:
    "Lists the Doxa projects this connection may use, with each project's ID, slug, live docs URL, and team (null for a personal project). Team projects are included. Start here to find a project ID.",
  scope: "projects:read",
  cost: "read",
  annotations: READ_ONLY_ANNOTATIONS,
  input: z.object({ cursor: cursorInput, limit: pageSizeInput(50) }).strict(),
  output: z
    .object({ projects: z.array(projectSchema), nextCursor: nextCursorOutput })
    .strict(),
  async run(context, input) {
    const projects = await context.listAccessibleProjects();
    const page = pageOf(projects, input.cursor, input.limit);
    return {
      projects: await context.services.projects.withDocsUrls(page.items),
      nextCursor: page.nextCursor,
    };
  },
});
