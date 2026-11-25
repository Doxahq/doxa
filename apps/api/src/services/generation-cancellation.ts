import { requestAgentContainerDestroy } from "@doxahq/generation";
import type { Env } from "../env";
import type { CancelledReviewRunPresentation } from "../repositories/cancelled-review-run";
import type { JobCancellation } from "../repositories/jobs";
import type { ReviewRunCanceller } from "./doxabot/review-runs";
import { generationMeteringFromEnv } from "./billing/generation-metering-env";
import { reportGenerationFinishedInBackground } from "./generation-analytics";

interface CancellationJobs {
  markCancelled(
    jobId: string,
    message: string,
    eventType?: string,
    data?: Record<string, unknown>,
    check?: CancelledReviewRunPresentation,
  ): Promise<boolean>;
  addEvent(
    jobId: string,
    type: string,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface GenerationCancellationInput extends JobCancellation {
  jobId: string;
}

/** The check text of a preview that a person, an agent or Doxa cancelled. */
export const CANCELLED_PREVIEW_CHECK: CancelledReviewRunPresentation = {
  title: "Documentation preview cancelled",
  summary: "Doxa cancelled documentation preview generation for this pull request.",
};

/** The check text of a preview that a newer push of its pull request replaced. */
export const SUPERSEDED_PREVIEW_CHECK: CancelledReviewRunPresentation = {
  title: "Documentation preview superseded",
  summary: "A newer pull request revision is available, so this preview was cancelled.",
};

export interface GenerationCancellationResult {
  transitioned: boolean;
  containerDestroyRequested: boolean;
}

/**
 * Cancels an active job, completes the pull request check of a preview job,
 * and asks the agent container to stop. A person, an agent and a pull
 * request that ends cancel through here. A newer push cancels the older run
 * in its admission, then uses `finishGenerationCancellation`.
 */
export async function cancelGenerationJob(
  env: Env,
  jobs: CancellationJobs,
  input: GenerationCancellationInput,
  previewChecks: ReviewRunCanceller,
): Promise<GenerationCancellationResult> {
  // The cancel event keeps the check text, for a check that is created now.
  const transitioned = await jobs.markCancelled(
    input.jobId,
    input.message,
    input.eventType,
    input.data,
    input.check,
  );
  if (!transitioned) {
    return { transitioned: false, containerDestroyRequested: false };
  }

  const containerDestroyRequested = await finishGenerationCancellation(
    env,
    jobs,
    input,
    previewChecks,
  );
  return { transitioned: true, containerDestroyRequested };
}

/**
 * The steps after a committed cancel: it closes the pull request check of a
 * preview job and asks the agent container to stop. A preview admission that
 * replaces an older run commits that cancel itself, then calls this. True
 * when the container destroy was requested.
 */
export async function finishGenerationCancellation(
  env: Env,
  jobs: Pick<CancellationJobs, "addEvent">,
  input: GenerationCancellationInput,
  previewChecks: ReviewRunCanceller,
): Promise<boolean> {
  // Billing spec 10.5 step 5: a cancel charges base + usage, a newer push
  // usage only. The outcome comes from the job's cancel event. Never throws.
  await generationMeteringFromEnv(env).settle(input.jobId);
  reportGenerationFinishedInBackground(env, input.jobId);
  await closePreviewCheck(jobs, previewChecks, input);

  // The job is already cancelled in the database. A failure to reach the
  // container must not turn a committed cancellation into a server error.
  return recordContainerDestroyAttempt(env, jobs, input.jobId).catch(
    (error: unknown) => {
      console.error("Container destroy attempt failed.", {
        jobId: input.jobId,
        message: error instanceof Error ? error.message : "Unknown error.",
      });
      return false;
    },
  );
}

/**
 * The worker stops at its next step without touching the check, so the check
 * closes here. A GitHub failure must not undo a committed cancellation.
 */
export async function closePreviewCheck(
  jobs: Pick<CancellationJobs, "addEvent">,
  previewChecks: ReviewRunCanceller,
  input: GenerationCancellationInput,
): Promise<void> {
  try {
    await previewChecks.cancel(input.jobId, input.check ?? CANCELLED_PREVIEW_CHECK);
  } catch (error) {
    await jobs
      .addEvent(
        input.jobId,
        "review_run_update_failed",
        "Doxabot could not mark the pull request check as cancelled.",
        { error: error instanceof Error ? error.message : "Unknown error." },
      )
      .catch(() => undefined);
  }
}

export async function recordContainerDestroyAttempt(
  env: Env,
  jobs: Pick<CancellationJobs, "addEvent">,
  jobId: string,
): Promise<boolean> {
  const destroyed = await requestAgentContainerDestroy(jobId, {
    agentContainerBinding: env.AGENT_CONTAINER,
    agentContainerUrl: env.AGENT_CONTAINER_URL,
  });
  await jobs.addEvent(
    jobId,
    destroyed ? "container_destroy_requested" : "container_destroy_unavailable",
    destroyed
      ? "Agent container destroy requested."
      : "Agent container destroy could not be requested from this runtime.",
    { ok: destroyed },
  );
  return destroyed;
}
