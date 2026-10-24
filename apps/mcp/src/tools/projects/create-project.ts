import { z } from "zod";
import { projectCreateAction } from "@doxahq/api/services/agent-actions/actions/project-create";
import { additiveActionAnnotations, defineActionTool } from "../action-tool";

export const createProjectTool = defineActionTool({
  name: "create_project",
  title: "Create a project",
  description:
    'Creates a docs project. source "example" starts from the Doxa example docs. source "repository" connects a GitHub repository from list_github_repositories; call start_generation after it to write the docs.',
  action: "project.create",
  scope: "projects:write",
  annotations: additiveActionAnnotations,
  input: z
    .object({
      source: z.enum(["example", "repository"]),
      name: z.string().trim().min(1).max(100).optional().describe("Required for the example source."),
      slug: z.string().trim().min(2).max(63).optional().describe("The subdomain of the docs site."),
      githubRepositoryId: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe("Required for the repository source, from list_github_repositories."),
    })
    .strict(),
  result: projectCreateAction.resultSchema,
  toCall: (input) => ({
    projectId: null,
    payload:
      input.source === "example"
        ? { source: "example", name: input.name, ...(input.slug ? { slug: input.slug } : {}) }
        : {
            source: "repository",
            githubRepositoryId: input.githubRepositoryId,
            ...(input.name ? { name: input.name } : {}),
            ...(input.slug ? { slug: input.slug } : {}),
          },
  }),
});
