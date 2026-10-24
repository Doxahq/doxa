import { z } from "zod";
import { docsDomainSchema } from "@doxahq/contracts";
import { ALL_APPROVAL_MODES, DEFAULT_TTL_HOURS } from "../action-definition";
import { FRESH } from "../freshness";
import { defineProjectAction } from "../registered-action";
import { emptySchema } from "./shared";

const payloadSchema = z
  .object({ hostname: z.string().trim().toLowerCase().min(1).max(253) })
  .strict();

export const domainAddAction = defineProjectAction({
  kind: "domain.add",
  payloadVersion: 1,
  title: "Add a custom domain",
  scope: "domains:write",
  capability: "domains.write",
  payloadSchema,
  snapshotSchema: emptySchema,
  resultSchema: docsDomainSchema,
  approval: { defaultMode: "require_approval", allowedModes: ALL_APPROVAL_MODES, ttlHours: DEFAULT_TTL_HOURS },
  review: { kind: "approval_page" },
  targetKey: (payload) => `hostname:${payload.hostname}`,
  reviewInputs: (payload) => ({ hostname: payload.hostname }),
  describe: (payload) => ({
    headline: `Add the custom domain ${payload.hostname}`,
    effects: [
      `The site gets the custom domain ${payload.hostname}.`,
      "You must add the DNS records that Doxa shows before the domain works.",
    ],
  }),
  capture: async () => ({}),
  // Nothing to compare: execution can still fail when the hostname is taken.
  checkFresh: async () => FRESH,
  execute(execution, payload) {
    return execution.services.domains.create({
      userId: execution.target.ownerUserId,
      projectId: execution.target.projectId,
      hostname: payload.hostname,
    });
  },
});
