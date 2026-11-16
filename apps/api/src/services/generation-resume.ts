import {
  GENERATION_RESUMED_EVENT_TYPE,
  type GenerateJobMessage,
  type GenerationActionBlockedReason,
} from "@doxahq/contracts";
import type { Env } from "../env";
import type { RecordedStepFailure } from "../repositories/generation-detail";
import {
  ActiveGenerationConflictError,
  JobsRepository,
  type GenerationRerunSource,
} from "../repositories/jobs";
import { getResumeBlockedReason, isOffProductionBranch } from "./generation-actions";
import type { GenerationQueue } from "./generation-dispatch";
import type { BillingRefusal, GenerationMetering, MeterAdmission } from "./billing/generation-metering";
import { meteredActionOf, requiredFeaturesOf, runModels } from "./billing/generation-metering";
import { generationMeteringFromEnv } from "./billing/generation-metering-env";

export type GenerationResumeOutcome =
  | { outcome: "not_found" }
  | { outcome: "blocked"; reason: GenerationActionBlockedReason }
  | { outcome: "resumed"; fromStep: string }
  /** Billing refused the continued run (spec 10.5: a continue is a new admission). */
  | { outcome: "billing_refused"; error: BillingRefusal };

export interface GenerationResumeInput {
  /** The project owner, who pays for the run. */
  userId: string;
  projectId: string;
  jobId: string;
}

export interface GenerationResumeDependencies {
  jobs: Pick<JobsRepository, "getRerunSource" | "latestStepFailure" | "reopenFailedJob"> & {
    addEvent(
      jobId: string,
      type: string,
      message: string,
      data?: Record<string, unknown>,
    ): Promise<unknown>;
  };
  queue: GenerationQueue;
  now: () => Date;
  /** The credit meter. Absent: no metering, as with `BILLING_ENFORCEMENT=off`. */
  metering?: Pick<GenerationMetering, "mode" | "admit" | "abandon" | "heldActionOf" | "settle">;
  /** The fallback writer of the run's models. */
  runModels?: (config: { plannerModel: string; writerModel: string }) => string[];
}

/**
 * Continues a failed run from the Workflow step that failed. The run keeps
 * its job, its commit and its settings, and every earlier step keeps its
 * result, so the plan and the written pages are not paid for again. A run
 * that cannot continue starts again with a re-run instead.
 */
export class GenerationResumeService {
  constructor(private readonly deps: GenerationResumeDependencies) {}

  static fromEnv(env: Env): GenerationResumeService {
    return new GenerationResumeService({
      jobs: new JobsRepository(env),
      queue: env.GENERATION_QUEUE,
      now: () => new Date(),
      metering: generationMeteringFromEnv(env),
      runModels: (config) => runModels(env, config),
    });
  }

  async resume(input: GenerationResumeInput): Promise<GenerationResumeOutcome> {
    const run = await this.deps.jobs.getRerunSource(input);
    if (!run) return { outcome: "not_found" };

    const stepFailure = await this.deps.jobs.latestStepFailure(run.id);
    const blocked = resumeBlockedReason(run, stepFailure, this.deps.now());
    if (blocked || !stepFailure) return { outcome: "blocked", reason: blocked ?? "not_resumable" };

    // Billing spec 10.5: the continued run holds credits again under its own key.
    const { metering } = this.deps;
    const metered = metering !== undefined && metering.mode !== "off";
    let admission: MeterAdmission | null = null;
    if (metered) {
      const models = run.plannerModel && run.writerModel
        ? this.deps.runModels?.({ plannerModel: run.plannerModel, writerModel: run.writerModel }) ?? [run.plannerModel, run.writerModel]
        : [];
      // The continued run keeps the action of its first admission. Its
      // baseline can be gone by now (a collected version clears the column),
      // so the job's row decides only when the meter holds nothing for it.
      const action = (await metering.heldActionOf(run.id)) ?? meteredActionOf(run);
      // The run ended, so a hold that its last try left (a settle that
      // failed) is charged now, with its own missed usage. A job holds
      // credits once at a time: a continue then opens the only hold.
      if (metering.mode === "on") await metering.settle(run.id);
      admission = await metering.admit({
        jobId: run.id,
        projectId: run.projectId,
        action,
        features: requiredFeaturesOf(run, action),
        models,
        attempt: `resume:${crypto.randomUUID()}`,
      });
      if (admission.kind === "refused") return { outcome: "billing_refused", error: admission.error };
      // Another continue of this job holds credits: it runs, this one does not.
      if (admission.kind === "busy") return { outcome: "blocked", reason: "in_progress" };
    }

    try {
      if (!(await this.deps.jobs.reopenFailedJob(run.id))) {
        if (metered && admission) await metering.abandon(run.id, admission);
        return { outcome: "blocked", reason: "not_resumable" };
      }
    } catch (error) {
      if (metered && admission) await metering.abandon(run.id, admission);
      if (error instanceof ActiveGenerationConflictError) {
        return { outcome: "blocked", reason: "in_progress" };
      }
      throw error;
    }

    const { stepName, count } = stepFailure.failure;
    // The workflow counts its time budget again from this event.
    await this.deps.jobs.addEvent(
      run.id,
      GENERATION_RESUMED_EVENT_TYPE,
      `Continuing from "${stepName}".`,
      { stepName, count },
    );
    const message: GenerateJobMessage = {
      jobId: run.id,
      projectId: run.projectId,
      userId: input.userId,
      restartFrom: { name: stepName, count },
    };
    await this.deps.queue.send(message);
    return { outcome: "resumed", fromStep: stepName };
  }
}

function resumeBlockedReason(
  run: GenerationRerunSource,
  stepFailure: RecordedStepFailure | null,
  now: Date,
): GenerationActionBlockedReason | null {
  return getResumeBlockedReason({
    status: run.status,
    publicationMode: run.publicationMode,
    isSuperseded: run.supersededByJobId !== null,
    // The same rules as the generation page, so an API call cannot do what
    // the disabled button does not.
    changeState: run.change?.state ?? null,
    changeOffProductionBranch: isOffProductionBranch(run.change, run.productionBranch),
    failedStep: stepFailure?.failure ?? null,
    failedAt: stepFailure?.failedAt ?? null,
    now,
  });
}
