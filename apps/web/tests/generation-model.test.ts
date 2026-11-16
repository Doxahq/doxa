import { describe, expect, test } from "vitest"
import type {
  GenerationDetailDto,
  GenerationJobDto,
  GenerationStartResultDto,
  GenerationsPageDto,
} from "@doxahq/contracts"
import * as generationModel from "~/lib/dashboard/generation-model"

import {
  canCancelGeneration,
  dedupeGenerations,
  formatGenerationDuration,
  getActionBlockedMessage,
  getDeploymentLabel,
  getDomainRoleLabel,
  getGenerationTitle,
  getGenerationDurationMs,
  getRerunLinks,
  shortenGenerationId,
} from "~/lib/dashboard/generation-model"

describe("generation dashboard model", () => {
  test("reads no re-run links from an API that sends none", () => {
    const linked = { ...createGenerationDetail(), rerunLinks: { rerunOfId: "job-failed", rerunId: null } }
    expect(getRerunLinks(linked)).toEqual({ rerunOfId: "job-failed", rerunId: null })

    const { rerunLinks: _rerunLinks, ...older } = createGenerationDetail()
    expect(getRerunLinks(older as GenerationDetailDto)).toEqual({ rerunOfId: null, rerunId: null })
  })

  test("allows cancellation only while a generation is active", () => {
    expect(canCancelGeneration(createGeneration({ status: "queued" }))).toBe(true)
    expect(canCancelGeneration(createGeneration({ status: "running" }))).toBe(true)
    expect(canCancelGeneration(createGeneration({ status: "succeeded" }))).toBe(false)
    expect(canCancelGeneration(createGeneration({ status: "failed" }))).toBe(false)
    expect(canCancelGeneration(createGeneration({ status: "cancelled" }))).toBe(false)
  })

  test("deduplicates overlapping cursor pages without changing order", () => {
    const newest = createGeneration({ id: "job-newest" })
    const overlap = createGeneration({ id: "job-overlap" })
    const oldest = createGeneration({ id: "job-oldest" })
    const pages: GenerationsPageDto[] = [
      { generations: [newest, overlap], nextCursor: "next" },
      { generations: [overlap, oldest], nextCursor: null },
    ]

    expect(dedupeGenerations(pages)).toEqual([newest, overlap, oldest])
  })

  test("uses updated time for terminal durations and current time for active jobs", () => {
    const terminal = createGeneration({
      status: "succeeded",
      createdAt: "2026-07-18T12:00:00.000Z",
      updatedAt: "2026-07-18T12:02:03.000Z",
    })
    const active = createGeneration({
      status: "running",
      createdAt: "2026-07-18T12:00:00.000Z",
      updatedAt: "2026-07-18T12:00:05.000Z",
    })
    const now = new Date("2026-07-18T12:03:00.000Z").getTime()

    expect(getGenerationDurationMs(terminal, now)).toBe(123_000)
    expect(getGenerationDurationMs(active, now)).toBe(180_000)
    expect(formatGenerationDuration(123_000)).toBe("2m 03s")
  })

  test("leaves out each wait before a continue", () => {
    // 2026-11-16: a run stopped for credits after 8s, waited 10h 27m, then
    // worked for 16m 03s. The page showed 10h 43m.
    const job = createGeneration({
      status: "succeeded",
      createdAt: "2026-11-15T23:05:50.000Z",
      updatedAt: "2026-11-16T09:49:23.000Z",
    })
    const events = [
      { type: "queued", createdAt: "2026-11-15T23:05:50.000Z" },
      { type: "credits_stopped", createdAt: "2026-11-15T23:05:58.000Z" },
      { type: "generation_resumed", createdAt: "2026-11-16T09:33:17.000Z" },
      { type: "credits_stopped", createdAt: "2026-11-16T09:39:36.000Z" },
      { type: "generation_resumed", createdAt: "2026-11-16T09:46:20.000Z" },
      { type: "staged_for_review", createdAt: "2026-11-16T09:49:23.000Z" },
    ]
    const now = new Date("2026-11-16T12:00:00.000Z").getTime()

    expect(formatGenerationDuration(getGenerationDurationMs(job, now))).toBe("10h 43m")
    // 8s + 6m 19s + 3m 03s
    expect(getGenerationDurationMs(job, now, events)).toBe(570_000)
    expect(formatGenerationDuration(getGenerationDurationMs(job, now, events))).toBe("9m 30s")
    // The generations list has no events: the API sends the wait.
    expect(getGenerationDurationMs({ ...job, pausedMs: 38_043_000 }, now)).toBe(570_000)
  })

  test("shortens long generation IDs without changing short IDs", () => {
    expect(shortenGenerationId("11111111-1111-4111-8111-111111111111")).toBe("11111111…1111")
    expect(shortenGenerationId("job-1")).toBe("job-1")
  })

  test("formats generation detail labels from contract values", () => {
    expect(getGenerationTitle(createGenerationDetail())).toBe(
      "Generation job-1",
    )
    expect(getDomainRoleLabel("production")).toBe("Production")
    expect(getDomainRoleLabel("generated")).toBe("Generated")
    expect(getDomainRoleLabel("preview")).toBe("Preview")
    expect(getDomainRoleLabel("permanent")).toBe("Permanent")
  })

  test.each([
    ["not_succeeded", "This generation did not succeed."],
    ["no_docs_version", "This generation published no documentation version."],
    ["already_production", "This generation is already live in production."],
    ["in_progress", "Cancel the generation before you delete it."],
    ["serving_production", "This generation is live in production."],
    ["serving_preview", "This generation is the current preview for its pull request."],
  ] as const)("maps %s to action help text", (reason, message) => {
    expect(getActionBlockedMessage(reason)).toBe(message)
  })

  test("maps generation states to deployment outcomes", () => {
    expect(getDeploymentLabel("succeeded")).toBe("Successful")
    expect(getDeploymentLabel("failed")).toBe("Failed")
    expect(getDeploymentLabel("cancelled")).toBe("Failed")
    expect(getDeploymentLabel("queued")).toBe("In progress")
    expect(getDeploymentLabel("running")).toBe("In progress")
  })

  test("requires confirmation before navigation for an unchanged generation", () => {
    const requiresConfirmation = (
      generationModel as typeof generationModel & {
        requiresGenerationConfirmation?: (
          result: GenerationStartResultDto,
        ) => boolean
      }
    ).requiresGenerationConfirmation

    expect(requiresConfirmation).toBeTypeOf("function")
    if (!requiresConfirmation) return

    expect(requiresConfirmation({
      job: null,
      outcome: "confirmation_required",
      reason: "unchanged_source",
      message: "The repository has not changed.",
    })).toBe(true)
    expect(requiresConfirmation({
      job: createGeneration(),
      outcome: "started",
      message: null,
    })).toBe(false)
  })
})

function createGeneration(overrides: Partial<GenerationJobDto> = {}): GenerationJobDto {
  return {
    id: "job-1",
    projectId: "project-1",
    status: "succeeded",
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
      canDelete: true,
      promoteBlockedReason: "no_docs_version",
      deleteBlockedReason: null,
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

describe("flagged pages", () => {
  test("an older API without flagged pages reads as none", async () => {
    const { readFlaggedPages, flaggedPagesHeading } = await import("~/lib/dashboard/flagged-pages")
    expect(readFlaggedPages({})).toEqual([])
    expect(flaggedPagesHeading(1)).toBe("1 page could not be written")
    expect(flaggedPagesHeading(3)).toBe("3 pages could not be written")
  })
})
