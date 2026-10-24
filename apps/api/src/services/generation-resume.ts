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
import { getResumeBlockedReason } from "./generation-actions";
import type { GenerationQueue } from "./generation-dispatch";

export type GenerationResumeOutcome =
  | { outcome: "not_found" }
  | { outcome: "blocked"; reason: GenerationActionBlockedReason }
  | { outcome: "resumed"; fromStep: string };

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
    });
  }

  async resume(input: GenerationResumeInput): Promise<GenerationResumeOutcome> {
    const run = await this.deps.jobs.getRerunSource(input);
    if (!run) return { outcome: "not_found" };

    const stepFailure = await this.deps.jobs.latestStepFailure(run.id);
    const blocked = resumeBlockedReason(run, stepFailure, this.deps.now());
    if (blocked || !stepFailure) return { outcome: "blocked", reason: blocked ?? "not_resumable" };

    try {
      if (!(await this.deps.jobs.reopenFailedJob(run.id))) {
        return { outcome: "blocked", reason: "not_resumable" };
      }
    } catch (error) {
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
    failedStep: stepFailure?.failure ?? null,
    failedAt: stepFailure?.failedAt ?? null,
    now,
  });
}
