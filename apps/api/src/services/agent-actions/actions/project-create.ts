import { z } from "zod";
import {
  createExampleProjectInputSchema,
  createProjectInputSchema,
  projectSchema,
} from "@doxahq/contracts";
import { ALL_APPROVAL_MODES, DEFAULT_TTL_HOURS } from "../action-definition";
import { FRESH } from "../freshness";
import { definePrincipalAction } from "../registered-action";
import { emptySchema } from "./shared";

const payloadSchema = z.discriminatedUnion("source", [
  createExampleProjectInputSchema.extend({ source: z.literal("example") }).strict(),
  createProjectInputSchema.extend({ source: z.literal("repository") }).strict(),
]);

type ProjectCreatePayload = z.infer<typeof payloadSchema>;

function projectLabel(payload: ProjectCreatePayload): string {
  return payload.name ?? "from the selected repository";
}

export const projectCreateAction = definePrincipalAction({
  kind: "project.create",
  payloadVersion: 1,
  title: "Create a project",
  scope: "projects:write",
  capability: "project.create",
  payloadSchema,
  snapshotSchema: emptySchema,
  resultSchema: projectSchema,
  approval: { defaultMode: "allow", allowedModes: ALL_APPROVAL_MODES, ttlHours: DEFAULT_TTL_HOURS },
  review: { kind: "approval_page" },
  targetKey: (payload) =>
    payload.source === "repository"
      ? `repository:${payload.githubRepositoryId}`
      : `example:${payload.slug ?? payload.name}`,
  reviewInputs: (payload) => ({
    source: payload.source,
    name: payload.name ?? null,
    slug: payload.slug ?? null,
    githubRepositoryId: payload.source === "repository" ? payload.githubRepositoryId : null,
    template: payload.source === "example" ? (payload.template ?? "starter") : null,
  }),
  describe: (payload) => ({
    headline: `Create the project ${projectLabel(payload)}`,
    effects: [
      "A new project is added to your account.",
      ...(payload.source === "example"
        ? [
            payload.template === "empty"
              ? "The project starts with one empty page that goes live at once."
              : "The project starts with example docs that go live at once.",
          ]
        : []),
    ],
  }),
  capture: async () => ({}),
  checkFresh: async () => FRESH,
  execute({ target, services }, payload) {
    if (payload.source === "example") {
      return services.projects.createExample({
        userId: target.userId,
        name: payload.name,
        slug: payload.slug,
        template: payload.template,
      });
    }
    return services.projects.createForRepository({
      userId: target.userId,
      githubRepositoryId: payload.githubRepositoryId,
      name: payload.name,
      slug: payload.slug,
    });
  },
});
