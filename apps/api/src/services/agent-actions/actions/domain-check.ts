import { z } from "zod";
import { docsDomainSchema } from "@doxahq/contracts";
import { ALL_APPROVAL_MODES, DEFAULT_TTL_HOURS } from "../action-definition";
import { ActionExecutionError } from "../errors";
import { domainFreshness } from "../freshness";
import { defineProjectAction } from "../registered-action";
import { emptySchema } from "./shared";

const payloadSchema = z.object({ domainId: z.uuid() }).strict();

/**
 * Runs in doxa-api because it calls the Cloudflare API, which the MCP
 * Worker has no credentials for. Allowed by default: it only reads state.
 */
export const domainCheckAction = defineProjectAction({
  kind: "domain.check",
  payloadVersion: 1,
  title: "Check a custom domain",
  scope: "domains:write",
  capability: "domains.write",
  payloadSchema,
  snapshotSchema: emptySchema,
  resultSchema: docsDomainSchema,
  approval: { defaultMode: "allow", allowedModes: ALL_APPROVAL_MODES, ttlHours: DEFAULT_TTL_HOURS },
  review: { kind: "approval_page" },
  targetKey: (payload) => `domain:${payload.domainId}`,
  reviewInputs: (payload) => ({ domainId: payload.domainId }),
  describe: () => ({
    headline: "Check the verification of a custom domain",
    effects: ["Doxa asks Cloudflare for the DNS and certificate state again."],
  }),
  capture: async () => ({}),
  async checkFresh({ target, services }, payload) {
    const domain = await services.domains.find({
      userId: target.ownerUserId,
      projectId: target.projectId,
      domainId: payload.domainId,
    });
    return domainFreshness(domain !== null);
  },
  async execute({ target, services }, payload) {
    const domain = await services.domains.refresh({
      userId: target.ownerUserId,
      projectId: target.projectId,
      domainId: payload.domainId,
    });
    if (domain === null) throw new ActionExecutionError("not_found", "The domain no longer exists.");
    return domain;
  },
});