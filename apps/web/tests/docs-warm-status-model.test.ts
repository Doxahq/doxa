import { describe, expect, test } from "vitest"
import type { DocsWarmStatus } from "@doxahq/contracts/docs-warm-job"

import {
  WARM_STATUS_POLL_MS,
  publishWarmJob,
  warmProgress,
  warmRegionsText,
  warmStatusPollInterval,
} from "~/lib/dashboard/docs-warm-status"

const PUBLISHED_AT = 1_000_000

function job(pools: DocsWarmStatus["pools"], startedAt: number | null = PUBLISHED_AT - 2_000): DocsWarmStatus {
  return { siteId: "site-1", releaseId: "a".repeat(64), startedAt, finishedAt: null, pools }
}

const done = (pool: DocsWarmStatus["pools"][number]["pool"]) => ({ pool, state: "done" as const, updatedAt: 1 })
const running = (pool: DocsWarmStatus["pools"][number]["pool"]) => ({ pool, state: "running" as const, updatedAt: 1 })

describe("publish warm status model", () => {
  test("counts the warm pools and the viewer's own", () => {
    const status = job([done("eu-west"), running("us-east"), { pool: "oceania", state: "failed", updatedAt: 1 }])

    expect(warmProgress(status, "eu-west")).toEqual({ done: 1, total: 3, settled: false, ownRegion: "done" })
    expect(warmProgress(status, "us-east").ownRegion).toBe("warming")
    expect(warmProgress(status, null).ownRegion).toBe("unknown")
    expect(warmRegionsText(warmProgress(status, null))).toBe("warming 1 of 3 regions")
  })

  test("shows a failed own pool as failed, not as warming", () => {
    const status = job([done("eu-west"), { pool: "us-east", state: "failed", updatedAt: 1 }, running("oceania")])

    expect(warmProgress(status, "us-east").ownRegion).toBe("failed")
  })

  test("ignores the job of an earlier publish and an empty status", () => {
    expect(publishWarmJob({ status: job([done("eu-west")], PUBLISHED_AT - 120_000), clientRegion: null }, PUBLISHED_AT)).toBeNull()
    expect(publishWarmJob({ status: job([]), clientRegion: null }, PUBLISHED_AT)).toBeNull()
    expect(publishWarmJob({ status: null, clientRegion: null }, PUBLISHED_AT)).toBeNull()
  })

  test("polls while the job runs and stops once it settles", () => {
    const now = PUBLISHED_AT + 5_000
    expect(warmStatusPollInterval({ status: job([done("eu-west"), running("us-east")]), clientRegion: null }, PUBLISHED_AT, now)).toBe(WARM_STATUS_POLL_MS)
    expect(warmStatusPollInterval({ status: job([done("eu-west"), done("us-east")]), clientRegion: null }, PUBLISHED_AT, now)).toBe(false)
  })

  test("waits a short while for the job to start, never for an unknown status", () => {
    const empty = { status: job([], null), clientRegion: null }
    expect(warmStatusPollInterval(empty, PUBLISHED_AT, PUBLISHED_AT + 10_000)).toBe(WARM_STATUS_POLL_MS)
    expect(warmStatusPollInterval(empty, PUBLISHED_AT, PUBLISHED_AT + 61_000)).toBe(false)
    expect(warmStatusPollInterval({ status: null, clientRegion: null }, PUBLISHED_AT, PUBLISHED_AT)).toBe(false)
    expect(warmStatusPollInterval(undefined, PUBLISHED_AT, PUBLISHED_AT)).toBe(false)
  })

  test("stops following a job older than 15 minutes", () => {
    const stale = { status: job([running("us-east")]), clientRegion: null }
    expect(warmStatusPollInterval(stale, PUBLISHED_AT, PUBLISHED_AT + 16 * 60_000)).toBe(false)
  })
})
