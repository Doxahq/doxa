import { z } from "zod";
import { ALL_APPROVAL_MODES, DEFAULT_TTL_HOURS } from "../action-definition";
import { ActionExecutionError } from "../errors";
import { domainFreshness } from "../freshness";
import { defineProjectAction } from "../registered-action";
import { requireProjectName } from "./project-name";

const payloadSchema = z.object({ domainId: z.uuid() }).strict();

const snapshotSchema = z
  .object({ domainId: z.uuid(), hostname: z.string(), projectName: z.string() })
  .strict();

const resultSchema = z.object({ removed: z.literal(true), hostname: z.string() }).strict();

const domainNotFound = () => new ActionExecutionError("domain_not_found", "Domain not found.");

export const domainRemoveAction = defineProjectAction({
  kind: "domain.remove",
  payloadVersion: 1,
  title: "Remove a custom domain",
  scope: "domains:write",
  capability: "domains.write",
  payloadSchema,
  snapshotSchema,
  resultSchema,
  approval: { defaultMode: "require_approval", allowedModes: ALL_APPROVAL_MODES, ttlHours: DEFAULT_TTL_HOURS },
  review: { kind: "approval_page" },
  targetKey: (payload) => `domain:${payload.domainId}`,
  reviewInputs: (payload) => ({ domainId: payload.domainId }),
  confirmationText: (_payload, snapshot) => snapshot.projectName,
  describe: (_payload, snapshot) => ({
    headline: `Remove the custom domain ${snapshot.hostname}`,
    effects: [`The site stops answering at ${snapshot.hostname}.`],
  }),
  async capture({ target, services }, payload) {
    const scoped = { userId: target.ownerUserId, projectId: target.projectId };
    const domain = await services.domains.find({ ...scoped, domainId: payload.domainId });
    if (domain === null) throw domainNotFound();
    if (domain.kind !== "custom_domain") {
      throw new ActionExecutionError("domain_not_removable", "Doxa-managed domains cannot be deleted.");
    }
    const projectName = await requireProjectName(services.projects, scoped);
    return { domainId: domain.id, hostname: domain.hostname, projectName };
  },
  async checkFresh({ target, services }, payload) {
    const domain = await services.domains.find({
      userId: target.ownerUserId,
      projectId: target.projectId,
      domainId: payload.domainId,
    });
    return domainFreshness(domain !== null);
  },
  async execute({ target, services }, payload, snapshot) {
    const removed = await services.domains.remove({
      userId: target.ownerUserId,
      projectId: target.projectId,
      domainId: payload.domainId,
    });
    if (!removed) throw domainNotFound();
    return { removed: true, hostname: snapshot.hostname };
  },
});
