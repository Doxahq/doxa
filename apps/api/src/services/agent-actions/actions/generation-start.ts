import { z } from "zod";
import { generationJobSchema } from "@doxahq/contracts";
import type { GenerationStartOutcome } from "../../generation-start";
import { repositoryRequiredMessage } from "../../repository-required-message";
import { ALL_APPROVAL_MODES, DEFAULT_TTL_HOURS } from "../action-definition";
import { ActionExecutionError } from "../errors";
import { generationFreshness } from "../freshness";
import { defineProjectAction } from "../registered-action";
import { billingRefusalActionError } from "../billing-refusal";

const payloadSchema = z.object({ force: z.boolean().default(false) }).strict();

const snapshotSchema = z.object({ force: z.boolean() }).strict();

const resultSchema = z.object({ job: generationJobSchema }).strict();

export const generationStartAction = defineProjectAction({
  kind: "generation.start",
  payloadVersion: 1,
  title: "Generate the docs",
  scope: "generation:run",
  capability: "generation.run",
  payloadSchema,
  snapshotSchema,
  resultSchema,
  approval: { defaultMode: "require_approval", allowedModes: ALL_APPROVAL_MODES, ttlHours: DEFAULT_TTL_HOURS },
  review: { kind: "approval_page" },
  targetKey: () => "generation",
  reviewInputs: (payload) => ({ force: payload.force }),
  describe: () => ({
    headline: "Generate the docs from the repository",
    effects: [
      "Doxa reads the repository and writes new docs.",
      "The generated docs go live when the run completes.",
    ],
  }),
  capture: async (_context, payload) => ({ force: payload.force }),
  async checkFresh({ target, services }) {
    return generationFreshness(await services.generation.hasActiveGeneration(target.projectId));
  },
  async execute({ target, services }, _payload, snapshot) {
    const outcome = await services.generation.start({
      userId: target.ownerUserId,
      projectId: target.projectId,
      force: snapshot.force,
    });
    if (outcome.outcome === "started") return { job: outcome.job };
    throw generationRefusal(outcome);
  },
});

type Refusal = Exclude<GenerationStartOutcome, { outcome: "started" }>;

function generationRefusal(outcome: Refusal): ActionExecutionError {
  switch (outcome.outcome) {
    case "not_found":
      return new ActionExecutionError("project_not_found", "Project not found.");
    case "repository_required":
      return new ActionExecutionError(
        "repository_required",
        outcome.reason ? repositoryRequiredMessage(outcome.reason) : "Connect a GitHub repository first.",
      );
    case "paused":
      return new ActionExecutionError("generation_paused", "Generation is paused. Try again later.");
    case "already_active":
    case "active_conflict":
      return new ActionExecutionError("generation_active", "A generation is already running.");
    case "confirmation_required":
      return new ActionExecutionError("confirmation_required", `${outcome.message} Start again with force set to true.`);
    case "dispatch_failed":
      return new ActionExecutionError("dispatch_failed", outcome.message);
    case "billing_refused":
      return billingRefusalActionError(outcome.error);
    case "repository_too_large":
      return new ActionExecutionError("repository_too_large", outcome.message);
  }
}
