import { z } from "zod";
import { DEFAULT_TTL_HOURS } from "../action-definition";
import { projectFreshness } from "../freshness";
import { defineProjectAction } from "../registered-action";
import { requireProjectName } from "./project-name";
import { emptySchema } from "./shared";

const snapshotSchema = z.object({ projectName: z.string() }).strict();

const resultSchema = z.object({ projectId: z.uuid(), deleted: z.literal(true) }).strict();

export const projectDeleteAction = defineProjectAction({
  kind: "project.delete",
  payloadVersion: 1,
  title: "Delete a project",
  scope: "projects:write",
  capability: "project.delete",
  payloadSchema: emptySchema,
  snapshotSchema,
  resultSchema,
  // Never `allow`: no policy source can delete a project without a human.
  approval: {
    defaultMode: "require_approval",
    allowedModes: ["require_approval", "deny"],
    ttlHours: DEFAULT_TTL_HOURS,
  },
  review: { kind: "approval_page" },
  targetKey: () => "project",
  reviewInputs: () => ({}),
  confirmationText: (_payload, snapshot) => snapshot.projectName,
  describe: (_payload, snapshot) => ({
    headline: `Delete the project ${snapshot.projectName}`,
    effects: [
      `The project ${snapshot.projectName}, its docs, and its domains are deleted.`,
      "The live site stops. This cannot be undone.",
    ],
  }),
  async capture({ target, services }) {
    const projectName = await requireProjectName(services.projects, {
      userId: target.ownerUserId,
      projectId: target.projectId,
    });
    return { projectName };
  },
  async checkFresh({ target, services }) {
    const project = await services.projects.find({
      userId: target.ownerUserId,
      projectId: target.projectId,
    });
    return projectFreshness(project !== null);
  },
  async execute({ target, services }) {
    const deleted = await services.projects.delete({
      userId: target.ownerUserId,
      projectId: target.projectId,
    });
    return { projectId: deleted.projectId, deleted: true };
  },
});
