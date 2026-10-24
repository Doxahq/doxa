import { afterEach, describe, expect, test, vi } from "vitest"
import type { GenerationDetailDto, GenerationJobDto } from "@doxahq/contracts"

import {
  cancelProjectGeneration,
  deleteDocsDomain,
  deleteProjectGeneration,
  getApiUrl,
  getDocsHostnameUrl,
  getProjectGeneration,
  getProjectPreviewVisibility,
  listDocsDomains,
  promoteProjectGeneration,
  rerunProjectGeneration,
  resumeProjectGeneration,
  startGeneration,
  updateProjectPreviewVisibility,
} from "~/lib/platform-api"

describe("platform API", () => {
  afterEach(() => vi.unstubAllGlobals())

  test("serves a docs hostname, such as a branch preview, through the local renderer", () => {
    expect(getDocsHostnameUrl("flagforge-br-edits-c80d141418772fe9.localhost")).toBe(
      "http://flagforge-br-edits-c80d141418772fe9.localhost:3002",
    )
  })

  test("serves a docs hostname on HTTPS in production", async () => {
    // A production build sets the docs domain and no renderer URL.
    vi.stubEnv("VITE_DOCS_BASE_DOMAIN", "doxa.page")
    vi.stubEnv("VITE_DOCS_RENDERER_BASE_URL", "")
    vi.resetModules()
    try {
      const api = await import("~/lib/platform-api")
      expect(api.getDocsHostnameUrl("flagforge-br-edits-c80d141418772fe9.doxa.page")).toBe(
        "https://flagforge-br-edits-c80d141418772fe9.doxa.page",
      )
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })

  test("cancels a generation through its owned project route", async () => {
    const generation = createGenerationDetail({ status: "cancelled" })
    const fetch = vi.fn(async () => Response.json({ generation }))
    vi.stubGlobal("fetch", fetch)

    await expect(
      cancelProjectGeneration("project 1", "job/1"),
    ).resolves.toEqual(generation)
    expect(fetch).toHaveBeenCalledWith(
      getApiUrl("/projects/project%201/generations/job%2F1/cancel"),
      expect.objectContaining({ method: "POST", credentials: "include" }),
    )
  })

  test("loads encoded generation detail paths", async () => {
    const generation = createGenerationDetail()
    const fetch = vi.fn(async () => Response.json({ generation }))
    vi.stubGlobal("fetch", fetch)

    await expect(getProjectGeneration("project 1", "job/1")).resolves.toEqual(
      generation,
    )
    expect(fetch).toHaveBeenCalledWith(
      getApiUrl("/projects/project%201/generations/job%2F1"),
      expect.objectContaining({ credentials: "include" }),
    )
  })

  test("promotes a generation through its owned project route", async () => {
    const generation = createGenerationDetail()
    const fetch = vi.fn(async () =>
      Response.json({ generation, publishedVersionId: "version-2" }),
    )
    vi.stubGlobal("fetch", fetch)

    await expect(
      promoteProjectGeneration("project 1", "job/1"),
    ).resolves.toEqual(generation)
    expect(fetch).toHaveBeenCalledWith(
      getApiUrl("/projects/project%201/generations/job%2F1/promote"),
      expect.objectContaining({ method: "POST", credentials: "include" }),
    )
  })

  test("runs a failed generation again through its owned project route", async () => {
    const job = { id: "job-2", projectId: "project 1", status: "queued", docsVersionId: null, errorMessage: null, createdAt: "2026-10-15T12:00:00.000Z", updatedAt: "2026-10-15T12:00:00.000Z" }
    const fetch = vi.fn(async () => Response.json({ job, outcome: "started", message: null }, { status: 202 }))
    vi.stubGlobal("fetch", fetch)

    await expect(
      rerunProjectGeneration("project 1", "job/1", { force: true, seed: true }),
    ).resolves.toEqual({ job, outcome: "started", message: null })
    expect(fetch).toHaveBeenCalledWith(
      getApiUrl("/projects/project%201/generations/job%2F1/rerun?force=true&seed=true"),
      expect.objectContaining({ method: "POST", credentials: "include" }),
    )
  })

  test("continues a failed generation from its failed step", async () => {
    const generation = { id: "job/1", status: "running" }
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ generation }), { status: 200 })))

    await expect(resumeProjectGeneration("project 1", "job/1")).resolves.toEqual(generation)
    expect(fetch).toHaveBeenCalledWith(
      getApiUrl("/projects/project%201/generations/job%2F1/resume"),
      expect.objectContaining({ method: "POST", credentials: "include" }),
    )
  })

  test("deletes a generation through its owned project route", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetch)

    await expect(
      deleteProjectGeneration("project 1", "job/1"),
    ).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledWith(
      getApiUrl("/projects/project%201/generations/job%2F1"),
      expect.objectContaining({ method: "DELETE", credentials: "include" }),
    )
  })

  test("deletes a custom domain through its owned project route", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }))
    vi.stubGlobal("fetch", fetch)

    await expect(
      deleteDocsDomain("project-1", "domain-1"),
    ).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledWith(
      getApiUrl("/projects/project-1/docs-domains/domain-1"),
      expect.objectContaining({ method: "DELETE", credentials: "include" }),
    )
  })

  test("loads docs domains with the project limit", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ domains: [], customDomainLimit: 1 }),
    )
    vi.stubGlobal("fetch", fetch)

    await expect(listDocsDomains("project-1")).resolves.toEqual({
      domains: [],
      customDomainLimit: 1,
    })
  })

  test("loads and updates generation preview visibility", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ previewVisibility: "private" }))
      .mockResolvedValueOnce(Response.json({ previewVisibility: "public" }))
    vi.stubGlobal("fetch", fetch)

    await expect(getProjectPreviewVisibility("project 1")).resolves.toEqual({
      previewVisibility: "private",
    })
    await expect(
      updateProjectPreviewVisibility("project 1", {
        previewVisibility: "public",
      }),
    ).resolves.toEqual({ previewVisibility: "public" })

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      getApiUrl("/projects/project%201/preview-visibility"),
      expect.objectContaining({ credentials: "include" }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      getApiUrl("/projects/project%201/preview-visibility"),
      expect.objectContaining({
        method: "PUT",
        credentials: "include",
        body: JSON.stringify({ previewVisibility: "public" }),
      }),
    )
  })

  test("preserves the generation admission outcome and user message", async () => {
    const job = createGeneration({ status: "running" })
    const result = {
      job,
      outcome: "already_active" as const,
      message:
        "A generation is already in progress for this project. No new generation was started.",
    }
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(result)))

    await expect(startGeneration("project-1")).resolves.toEqual(result)
  })

  test("requests a forced generation only after user confirmation", async () => {
    const job = createGeneration({ status: "queued" })
    const result = {
      job,
      outcome: "started" as const,
      message: null,
    }
    const fetch = vi.fn(async () => Response.json(result))
    vi.stubGlobal("fetch", fetch)

    await expect(startGeneration("project 1", { force: true })).resolves.toEqual(result)
    expect(fetch).toHaveBeenCalledWith(
      getApiUrl("/projects/project%201/generate?force=true"),
      expect.objectContaining({ method: "POST", credentials: "include" }),
    )
  })

  test("rejects a generation start response that breaks the contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      job: createGeneration(),
      outcome: "unknown",
      message: null,
    })))

    await expect(startGeneration("project-1")).rejects.toThrow()
  })
})

function createGeneration(
  overrides: Partial<GenerationJobDto> = {},
): GenerationJobDto {
  return {
    id: "job-1",
    projectId: "project-1",
    status: "running",
    docsVersionId: null,
    errorMessage: null,
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:01:00.000Z",
    ...overrides,
  }
}

function createGenerationDetail(
  overrides: Partial<GenerationDetailDto> = {},
): GenerationDetailDto {
  return {
    ...createGeneration({ status: "succeeded", docsVersionId: "version-1" }),
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
      isCurrent: true,
      state: "live",
      docsVersionId: "version-1",
      versionNumber: 1,
      visitUrl: "https://demo.doxa.page",
      domains: [],
    },
    actions: {
      canPromote: false,
      canDelete: false,
      promoteBlockedReason: "already_production",
      deleteBlockedReason: "serving_production",
      canRerun: false,
      rerunBlockedReason: "not_finished",
      canResume: false,
      resumeBlockedReason: "not_resumable",
    },
    rerunLinks: { rerunOfId: null, rerunId: null },
    flaggedPages: [],
    referenceSource: null,
    ...overrides,
  }
}
