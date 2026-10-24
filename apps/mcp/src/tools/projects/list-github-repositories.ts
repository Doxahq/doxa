import { githubRepositorySchema } from "@doxahq/contracts";
import { z } from "zod";
import { defineMcpTool } from "../../tool-definition";
import {
  cursorInput,
  nextCursorOutput,
  pageOf,
  pageSizeInput,
  READ_ONLY_ANNOTATIONS,
} from "../shared";

export const listGithubRepositoriesTool = defineMcpTool({
  name: "list_github_repositories",
  title: "List GitHub repositories",
  description:
    "Lists the GitHub repositories that the user installed the Doxa GitHub App on. A repository ID here can create a project.",
  scope: "projects:read",
  cost: "read",
  annotations: READ_ONLY_ANNOTATIONS,
  input: z.object({ cursor: cursorInput, limit: pageSizeInput(50) }).strict(),
  output: z
    .object({
      repositories: z.array(githubRepositorySchema),
      nextCursor: nextCursorOutput,
    })
    .strict(),
  async run({ actor, services }, input) {
    const repositories = await services.github.listRepositories(
      actor.principal.userId,
    );
    const page = pageOf(repositories, input.cursor, input.limit);
    return { repositories: page.items, nextCursor: page.nextCursor };
  },
});
