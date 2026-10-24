import { z } from "zod";
import { generationDetailSchema } from "@doxahq/contracts";
import { ALL_APPROVAL_MODES, DEFAULT_TTL_HOURS } from "../action-definition";
import { ActionExecutionError } from "../errors";
import { FRESH } from "../freshness";
import { defineProjectAction } from "../registered-action";
import { emptySchema } from "./shared";

const payloadSchema = z.object({ generationId: z.uuid() }).strict();

const resultSchema = z.object({ generation: generationDetailSchema }).strict();

/**
 * Runs in doxa-api because stopping a run needs the container binding.
 * Allowed by default: a cancel stops work and publishes nothing.
 */
export const generationCancelAction = defineProjectAction({
  kind: "generation.cancel",
  payloadVersion: 1,
  title: "Cancel a generation",
  scope: "generation:run",
  capability: "generation.run",
  payloadSchema,
  snapshotSchema: emptySchema,
  resultSchema,
  approval: { defaultMode: "allow", allowedModes: ALL_APPROVAL_MODES, ttlHours: DEFAULT_TTL_HOURS },
  review: { kind: "approval_page" },
  targetKey: (payload) => `generation:${payload.generationId}`,
  reviewInputs: (payload) => ({ generationId: payload.generationId }),
  describe: () => ({
    headline: "Cancel a running generation",
    effects: ["The generation stops. The live site does not change."],
  }),
  capture: async () => ({}),
  // The cancel itself reports a finished run, so there is nothing to compare.
  checkFresh: async () => FRESH,
  async execute({ target, services }, payload) {
    const outcome = await services.generation.cancel({
      userId: target.ownerUserId,
      projectId: target.projectId,
      generationId: payload.generationId,
    });
    if (outcome.outcome === "cancelled") return { generation: outcome.generation };
    if (outcome.outcome === "not_found") {
      throw new ActionExecutionError("not_found", "The generation does not exist.");
    }
    throw new ActionExecutionError("generation_finished", "The generation has already finished.");
  },
});
