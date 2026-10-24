import { afterEach, describe, expect, test, vi } from "vitest"
import type {
  GenerationDetailDto,
  GenerationJobDto,
  JobEventDto,
} from "@doxahq/contracts"
import { QueryClient } from "@tanstack/react-query"

import {
  appendGenerationEvent,
  cacheStartedGeneration,
  createPendingGenerationDetail,
  mergeGenerationDetail,
  mergeGenerationIntoPages,
  withRerunId,
} from "~/lib/dashboard/cache"
import { createSseParser } from "~/lib/generation-stream"
import * as generationStream from "~/lib/generation-stream"
import { dashboardQueryKeys, type ProjectDetail } from "~/lib/queries/dashboard"

describe("generation stream", () => {
  afterEach(() => vi.useRealTimers())

  test("parses split CRLF frames and preserves multiline data", () => {
    const onFrame = vi.fn()
    const parser = createSseParser(onFrame)

    parser.push("event: event\r\ndata: {\"type\":\"event\"}\r")
    parser.push("\nid: 12\r\n\r\n")

    expect(onFrame).toHaveBeenCalledWith({
      event: "event",
      data: "{\"type\":\"event\"}",
      id: "12",
    })
  })

  test("ignores comments and emits the final unterminated frame", () => {
    const onFrame = vi.fn()
    const parser = createSseParser(onFrame)

    parser.push(": heartbeat\nevent: heartbeat\ndata: first\ndata: second")
    parser.finish()

    expect(onFrame).toHaveBeenCalledWith({
      event: "heartbeat",
      data: "first\nsecond",
      id: null,
    })
  })

  test("deduplicates replayed events by id or sequence", () => {
    const event = createEvent()

    expect(appendGenerationEvent([event], { ...event, id: "event-replayed" })).toEqual([event])
    expect(appendGenerationEvent([event], { ...event, id: "event-2", sequence: 2 })).toEqual([
      event,
      { ...event, id: "event-2", sequence: 2 },
    ])
  })

  test("updates an existing generation inside infinite query pages", () => {
    const running = createGeneration()
    const succeeded = createGeneration({
      status: "succeeded",
      docsVersionId: "version-1",
      updatedAt: "2026-07-18T12:02:00.000Z",
    })
    const data = {
      pages: [{ generations: [running], nextCursor: null }],
      pageParams: [null],
    }

    expect(mergeGenerationIntoPages(data, succeeded)?.pages[0]?.generations).toEqual([succeeded])
  })

  test("keeps detail-only fields when a stream sends a base generation update", () => {
    const detail = createGenerationDetail()
    const succeeded = createGeneration({
      status: "succeeded",
      docsVersionId: "version-1",
    })

    expect(mergeGenerationDetail(detail, succeeded)).toEqual({
      ...detail,
      ...succeeded,
    })
  })

  test("seeds a pending detail for a started job", () => {
    const queryClient = new QueryClient()
    const job = createGeneration()
    queryClient.setQueryData<ProjectDetail>(
      dashboardQueryKeys.project(job.projectId),
      createProjectDetail(),
    )

    cacheStartedGeneration(queryClient, job.projectId, job)

    expect(queryClient.getQueryData<GenerationDetailDto>(
      dashboardQueryKeys.generation(job.projectId, job.id),
    )).toEqual(createPendingGenerationDetail(job))
    expect(queryClient.getQueryData<ProjectDetail>(
      dashboardQueryKeys.project(job.projectId),
    )?.latestJob).toEqual(job)
  })

  test("links a re-run and its failed run before the server answers", () => {
    const queryClient = new QueryClient()
    const job = createGeneration({ id: "job-rerun" })

    cacheStartedGeneration(queryClient, job.projectId, job, { rerunOfId: "job-failed" })

    expect(queryClient.getQueryData<GenerationDetailDto>(
      dashboardQueryKeys.generation(job.projectId, job.id),
    )?.rerunLinks).toEqual({ rerunOfId: "job-failed", rerunId: null })
    const failed = createPendingGenerationDetail(createGeneration({ id: "job-failed", status: "failed" }))
    expect(withRerunId(failed, "job-rerun")?.rerunLinks).toEqual({ rerunOfId: null, rerunId: "job-rerun" })
    expect(withRerunId(undefined, "job-rerun")).toBeUndefined()
  })

  test("keeps a stream status update when no detail is cached yet", () => {
    const queryClient = new QueryClient()
    const cancelled = createGeneration({ status: "cancelled" })

    queryClient.setQueryData<GenerationDetailDto | undefined>(
      dashboardQueryKeys.generation(cancelled.projectId, cancelled.id),
      (detail) =>
        mergeGenerationDetail(detail, cancelled)
        ?? createPendingGenerationDetail(cancelled),
    )

    expect(queryClient.getQueryData<GenerationDetailDto>(
      dashboardQueryKeys.generation(cancelled.projectId, cancelled.id),
    )?.status).toBe("cancelled")
  })

  test("keeps a cached detail when a started job arrives", () => {
    const queryClient = new QueryClient()
    const detail = createGenerationDetail()
    const job = createGeneration({ status: "succeeded" })
    queryClient.setQueryData(
      dashboardQueryKeys.generation(job.projectId, job.id),
      detail,
    )

    cacheStartedGeneration(queryClient, job.projectId, job)

    expect(queryClient.getQueryData<GenerationDetailDto>(
      dashboardQueryKeys.generation(job.projectId, job.id),
    )).toEqual({ ...detail, ...job })
  })

  test("reports a silent stream after the heartbeat grace period", () => {
    vi.useFakeTimers()
    const onSilence = vi.fn()
    const factory = (
      generationStream as typeof generationStream & {
        createGenerationStreamWatchdog?: (onSilence: () => void) => {
          receivedMessage: () => void
          stop: () => void
        }
      }
    ).createGenerationStreamWatchdog

    expect(factory).toBeTypeOf("function")
    if (!factory) return

    const watchdog = factory(onSilence)
    watchdog.receivedMessage()
    vi.advanceTimersByTime(29_999)
    expect(onSilence).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onSilence).toHaveBeenCalledOnce()
  })

  test("resets and stops the stream silence watchdog", () => {
    vi.useFakeTimers()
    const onSilence = vi.fn()
    const factory = (
      generationStream as typeof generationStream & {
        createGenerationStreamWatchdog?: (onSilence: () => void) => {
          receivedMessage: () => void
          stop: () => void
        }
      }
    ).createGenerationStreamWatchdog

    expect(factory).toBeTypeOf("function")
    if (!factory) return

    const watchdog = factory(onSilence)
    watchdog.receivedMessage()
    vi.advanceTimersByTime(20_000)
    watchdog.receivedMessage()
    vi.advanceTimersByTime(20_000)
    expect(onSilence).not.toHaveBeenCalled()
    watchdog.stop()
    vi.advanceTimersByTime(30_000)
    expect(onSilence).not.toHaveBeenCalled()
  })
})

function createGeneration(overrides: Partial<GenerationJobDto> = {}): GenerationJobDto {
  return {
    id: "job-1",
    projectId: "project-1",
    status: "running",
    docsVersionId: null,
    errorMessage: null,
    createdAt: "2026-07-18T12:00:00.000Z",
    updatedAt: "2026-07-18T12:01:00.000Z",
    ...overrides,
  }
}

function createGenerationDetail(): GenerationDetailDto {
  return {
    ...createGeneration(),
    trigger: "manual",
    author: {
      kind: "user",
      displayName: "octocat",
      githubLogin: "octocat",
      avatarUrl: null,
    },
    source: {
      provider: null,
      repositoryFullName: null,
      repositoryUrl: null,
      branch: null,
      branchUrl: null,
      commit: null,
      changeProposal: null,
    },
    deployment: {
      environment: "production",
      isCurrent: false,
      state: "not_published",
      docsVersionId: null,
      versionNumber: null,
      visitUrl: null,
      domains: [],
    },
    actions: {
      canPromote: false,
      canDelete: false,
      promoteBlockedReason: "not_succeeded",
      deleteBlockedReason: "in_progress",
      canRerun: false,
      rerunBlockedReason: "not_finished",
      canResume: false,
      resumeBlockedReason: "not_resumable",
    },
    rerunLinks: { rerunOfId: null, rerunId: null },
    flaggedPages: [],
    referenceSource: null,
  }
}

function createProjectDetail(): ProjectDetail {
  return {
    project: {
      id: "project-1",
      name: "Project One",
      slug: "project-one",
      githubRepositoryId: "repository-1",
      repositoryFullName: "acme/project-one",
      publishedVersionId: null,
      docsUrl: null,
      team: null,
    },
    latestJob: null,
    role: "owner",
  }
}

function createEvent(overrides: Partial<JobEventDto> = {}): JobEventDto {
  return {
    id: "event-1",
    jobId: "job-1",
    sequence: 1,
    source: "worker",
    type: "running",
    message: "Generation started.",
    data: null,
    createdAt: "2026-07-18T12:01:00.000Z",
    ...overrides,
  }
}
