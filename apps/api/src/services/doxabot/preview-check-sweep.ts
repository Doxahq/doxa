import type { Env } from "../../env";
import { JobsRepository } from "../../repositories/jobs";
import { ReviewRunsService } from "./review-runs";

/** A job that ended this recently may still be closing its check itself. */
export const PREVIEW_CHECK_CLOSE_GRACE_MS = 2 * 60_000;
/** After a day the sweep stops trying: GitHub marks the check `stale` after 14 days. */
export const PREVIEW_CHECK_GIVE_UP_MS = 24 * 60 * 60_000;
export const PREVIEW_CHECK_SWEEP_BATCH = 25;

type SweepLog = (event: string, data: Record<string, unknown>) => void;

export interface PreviewCheckSweepDependencies {
  jobs: Pick<JobsRepository, "listOpenReviewRunsOfEndedJobs">;
  checks: Pick<ReviewRunsService, "closeForEndedJob">;
  now(): Date;
  log: SweepLog;
}

/**
 * Closes the pull request check of every preview job that ended while its
 * check stayed open: a run that ended without closing it, or a close that
 * GitHub refused. Runs on the 5-minute cron.
 */
export class PreviewCheckSweeper {
  constructor(private readonly dependencies: PreviewCheckSweepDependencies) {}

  static fromEnv(env: Env): PreviewCheckSweeper {
    return new PreviewCheckSweeper({
      jobs: new JobsRepository(env),
      checks: ReviewRunsService.fromEnv(env),
      now: () => new Date(),
      log: (event, data) => console.log(JSON.stringify({ service: "doxa-api", event, ...data })),
    });
  }

  async run(): Promise<{ closed: number; failed: number }> {
    const now = this.dependencies.now().getTime();
    const jobIds = await this.dependencies.jobs.listOpenReviewRunsOfEndedJobs({
      endedAfter: new Date(now - PREVIEW_CHECK_GIVE_UP_MS),
      endedBefore: new Date(now - PREVIEW_CHECK_CLOSE_GRACE_MS),
      limit: PREVIEW_CHECK_SWEEP_BATCH,
    });

    let closed = 0;
    let failed = 0;
    // One at a time: each close creates an installation token and calls GitHub.
    for (const jobId of jobIds) {
      try {
        if (await this.dependencies.checks.closeForEndedJob(jobId)) closed += 1;
      } catch (error) {
        failed += 1;
        this.dependencies.log("preview_check_close_failed", {
          jobId,
          message: error instanceof Error ? error.message : "Unknown error.",
        });
      }
    }
    if (jobIds.length > 0) {
      this.dependencies.log("preview_check_sweep", { found: jobIds.length, closed, failed });
    }
    return { closed, failed };
  }
}
