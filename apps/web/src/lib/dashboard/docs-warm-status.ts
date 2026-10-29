import type { DocsWarmStatus } from "@doxahq/contracts/docs-warm-job"

import type { DocsWarmStatusResult } from "~/lib/docs-warm-status-api"

/** How often the publish menu asks for the warm progress. */
export const WARM_STATUS_POLL_MS = 3_000
/** A job older than this is not followed any more. */
export const WARM_STATUS_MAX_AGE_MS = 15 * 60_000
/** How long to wait for the publish's job to show up. */
export const WARM_JOB_START_GRACE_MS = 60_000
/**
 * The job starts inside the publish request, before its answer arrives, and
 * the dispatcher's clock is not the browser's: a job that started this much
 * before the publish answer still counts as the publish's job.
 */
export const WARM_JOB_CLOCK_SLACK_MS = 30_000

export interface WarmProgress {
  /** Pools that finished warming. */
  done: number
  /** Pools in the job. */
  total: number
  /** Every pool is done or failed. */
  settled: boolean
  /** The viewer's pool: warm, still warming, failed to warm, or not part of the job / unknown. */
  ownRegion: "done" | "warming" | "failed" | "unknown"
}

/** The warm job of the publish answered at `publishedAt`, or null when there is none (yet). */
export function publishWarmJob(result: DocsWarmStatusResult, publishedAt: number): DocsWarmStatus | null {
  const status = result.status
  if (!status || status.pools.length === 0 || status.startedAt === null) return null
  return status.startedAt >= publishedAt - WARM_JOB_CLOCK_SLACK_MS ? status : null
}

export function warmProgress(job: DocsWarmStatus, clientRegion: DocsWarmStatusResult["clientRegion"]): WarmProgress {
  const done = job.pools.filter((pool) => pool.state === "done").length
  const own = clientRegion ? job.pools.find((pool) => pool.pool === clientRegion) : undefined
  return {
    done,
    total: job.pools.length,
    settled: job.pools.every((pool) => pool.state === "done" || pool.state === "failed"),
    ownRegion: ownRegionState(own?.state),
  }
}

/** A failed pool is settled: it must not read as still warming. */
function ownRegionState(state: DocsWarmStatus["pools"][number]["state"] | undefined): WarmProgress["ownRegion"] {
  if (state === undefined) return "unknown"
  if (state === "done" || state === "failed") return state
  return "warming"
}

/**
 * The poll interval: every few seconds while the publish's job runs, and for
 * a short while until it shows up. Stops when the job settles, when it is
 * too old, when the status is unknown, or on an error.
 */
export function warmStatusPollInterval(
  result: DocsWarmStatusResult | undefined,
  publishedAt: number,
  now: number,
): number | false {
  if (!result || result.status === null) return false
  const job = publishWarmJob(result, publishedAt)
  if (!job) return now - publishedAt < WARM_JOB_START_GRACE_MS ? WARM_STATUS_POLL_MS : false
  if (job.startedAt !== null && now - job.startedAt > WARM_STATUS_MAX_AGE_MS) return false
  return warmProgress(job, result.clientRegion).settled ? false : WARM_STATUS_POLL_MS
}

/** "warming 3 of 8 regions", or "8 of 8 regions warm" once the job settles. */
export function warmRegionsText(progress: WarmProgress): string {
  const regions = progress.total === 1 ? "region" : "regions"
  return progress.settled
    ? `${progress.done} of ${progress.total} ${regions} warm`
    : `warming ${progress.done} of ${progress.total} ${regions}`
}
