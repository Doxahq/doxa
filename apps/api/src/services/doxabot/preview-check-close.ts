import type {
  ReviewRunEndState,
  ReviewRunEnding,
  ReviewRunsService,
} from "./review-runs";

interface CheckCloseEvents {
  addEvent(
    jobId: string,
    type: string,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface PreviewCheckClose {
  jobId: string;
  state: ReviewRunEndState;
  ending: ReviewRunEnding;
}

/**
 * Completes the pull request check of an ended preview job. The job has
 * ended either way, so a provider failure is recorded on the job and never
 * thrown; the cron closes the check later. A production job has no check,
 * so nothing happens for it.
 */
export async function finishPreviewCheckSafely(
  events: CheckCloseEvents,
  checks: Pick<ReviewRunsService, "finish">,
  input: PreviewCheckClose,
): Promise<void> {
  try {
    await checks.finish(input.jobId, input.state, input.ending);
  } catch (error) {
    await events
      .addEvent(
        input.jobId,
        "review_run_update_failed",
        "Doxabot could not complete the pull request check.",
        { error: error instanceof Error ? error.message : "Unknown error." },
      )
      .catch(() => undefined);
  }
}
