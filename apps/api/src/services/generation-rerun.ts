import type { GenerationActionBlockedReason } from "@doxahq/contracts";
import type { Env } from "../env";
import { RERUN_EVENT_TYPES } from "../repositories/job-events";
import { JobsRepository, type GenerationRerunSource } from "../repositories/jobs";
import type { Defer } from "./generation-dispatch";
import { getRerunBlockedReason } from "./generation-actions";
import type { GenerationStartedBy } from "./generation-analytics";
import { GenerationStartService, type GenerationStartOutcome } from "./generation-start";
import {
  PreviewGenerationRerunService,
  type PreviewRerunOutcome,
} from "./doxabot/preview-rerun";

export type GenerationRerunOutcome =
  | GenerationStartOutcome
  | PreviewRerunOutcome
  | { outcome: "blocked"; reason: GenerationActionBlockedReason };

export interface GenerationRerunInput {
  /** The project owner, who pays for the run. */
  userId: string;
  projectId: string;
  jobId: string;
  /** Confirms a production start that the server asked about. */
  force: boolean;
  /** Starts a production run from the pages written in the editor. */
  seed?: boolean;
  /** The person and the surface that started the run again (product analytics). */
  startedBy?: GenerationStartedBy;
}

export interface GenerationRerunDependencies {
  jobs: {
    getRerunSource(input: {
      userId: string;
      projectId: string;
      jobId: string;
    }): Promise<GenerationRerunSource | null>;
    addEvent(
      jobId: string,
      type: string,
      message: string,
      data?: Record<string, unknown>,
    ): Promise<unknown>;
  };
  production: Pick<GenerationStartService, "start">;
  preview: Pick<PreviewGenerationRerunService, "rerun">;
}

export const RERUN_SUCCEEDED_MESSAGE =
  "This generation already succeeded. If your code did not change, a new run will most likely give a very similar result. It still uses a full generation.";

/**
 * Starts an ended generation again: failed, cancelled, or succeeded. A
 * production run starts like a person's run does, on the default branch as it
 * is now, with the same confirmations. A preview run starts on its pull
 * request's head. A succeeded run asks first, and that answer stands for the
 * start's own questions too. The earlier run and the new run each record the
 * other.
 */
export class GenerationRerunService {
  constructor(private readonly deps: GenerationRerunDependencies) {}

  static fromEnv(env: Env, options: { defer: Defer }): GenerationRerunService {
    return new GenerationRerunService({
      jobs: new JobsRepository(env),
      production: GenerationStartService.fromEnv(env, options),
      preview: PreviewGenerationRerunService.fromEnv(env),
    });
  }

  async rerun(input: GenerationRerunInput): Promise<GenerationRerunOutcome> {
    const previous = await this.deps.jobs.getRerunSource(input);
    if (!previous) return { outcome: "not_found" };

    // The pull request's state and base are left to the preview service,
    // which reads them live from GitHub; the record can be behind.
    const blocked = getRerunBlockedReason({
      status: previous.status,
      publicationMode: previous.publicationMode,
      isSuperseded: previous.supersededByJobId !== null,
    });
    if (blocked) return { outcome: "blocked", reason: blocked };
    // A new run of a run that worked costs as much and most likely gives the
    // same result, so the person confirms it first.
    if (previous.status === "succeeded" && !input.force) {
      return {
        outcome: "confirmation_required",
        reason: "rerun_succeeded",
        message: RERUN_SUCCEEDED_MESSAGE,
      };
    }

    const outcome =
      previous.publicationMode === "preview"
        ? await this.deps.preview.rerun(previous)
        : await this.deps.production.start({
            userId: input.userId,
            projectId: input.projectId,
            force: input.force,
            seed: input.seed,
            trigger: "manual",
            ...(input.startedBy ? { startedBy: input.startedBy } : {}),
          });
    if (outcome.outcome === "started") {
      // Both runs keep the link, so each page links to the other run.
      await this.deps.jobs.addEvent(previous.id, RERUN_EVENT_TYPES.started, "Generation started again.", {
        jobId: outcome.job.id,
      });
      await this.deps.jobs.addEvent(outcome.job.id, RERUN_EVENT_TYPES.of, "Started again from an earlier generation.", {
        jobId: previous.id,
      });
    }
    return outcome;
  }
}
