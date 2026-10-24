import { afterEach, describe, expect, test, vi } from "vitest"
import type { DocsContentOverviewDto } from "@doxahq/contracts"

import { overviewSiteSettings } from "./fixtures/site-settings"

import {
  applyProjectContentEdits,
  getProjectContentMdxReport,
  getApiUrl,
  getProjectContent,
  getProjectContentPage,
} from "~/lib/platform-api"
import { publishDocsBranch, publishDocsBranchWithProgress } from "~/lib/docs-branches-api"

describe("docs content API client", () => {
  afterEach(() => vi.unstubAllGlobals())

  test("reads the content overview from the owned project route", async () => {
    const content = createOverview()
    const fetch = vi.fn(async () => Response.json({ content }))
    vi.stubGlobal("fetch", fetch)

    await expect(getProjectContent("project 1", "main")).resolves.toEqual(content)
    expect(fetch).toHaveBeenCalledWith(
      getApiUrl("/projects/project%201/content?branch=main"),
      expect.objectContaining({ credentials: "include" }),
    )
  })

  test("encodes the page href as a query parameter", async () => {
    const fetch = vi.fn(async () => Response.json({ page: createPage() }))
    vi.stubGlobal("fetch", fetch)

    await getProjectContentPage("project-1", "/rest-api/list flags", "main")
    expect(fetch).toHaveBeenCalledWith(
      getApiUrl("/projects/project-1/content/page?href=%2Frest-api%2Flist+flags&branch=main"),
      expect.objectContaining({ credentials: "include" }),
    )
  })

  test("posts an edit list without an origin", async () => {
    const fetch = vi.fn(async () => Response.json({ working: createOverview().working }))
    vi.stubGlobal("fetch", fetch)

    await applyProjectContentEdits("project-1", {
      edits: [{ type: "set_page_content", href: "/", content: "# Overview\n" }],
    })

    expect(fetch).toHaveBeenCalledWith(
      getApiUrl("/projects/project-1/content/edits"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          edits: [{ type: "set_page_content", href: "/", content: "# Overview\n" }],
          branch: "main",
        }),
      }),
    )
  })

  test("returns the MDX issues of a save, and reads the branch MDX report", async () => {
    const mdxIssues = [
      {
        href: "/",
        sourcePath: "source/index.mdx",
        issues: [{ line: 3, column: 1, message: "Unknown MDX component: Bogus" }],
      },
    ]
    const working = createOverview().working
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ working, mdxIssues })))
    await expect(
      applyProjectContentEdits("project-1", {
        edits: [{ type: "set_page_content", href: "/", content: "<Bogus />" }],
      }),
    ).resolves.toEqual({ working, mdxIssues })

    const fetch = vi.fn(async () => Response.json({ pages: mdxIssues }))
    vi.stubGlobal("fetch", fetch)
    await expect(getProjectContentMdxReport("project-1", "main")).resolves.toEqual({ pages: mdxIssues })
    expect(fetch).toHaveBeenCalledWith(
      getApiUrl("/projects/project-1/content/mdx-issues?branch=main"),
      expect.objectContaining({ credentials: "include" }),
    )
  })

  test("sends the expected base version and revision when publishing", async () => {
    const published = { versionId: "version-2", versionNumber: 4, publicationId: "publication-1", branchErased: false }
    const fetch = vi.fn(async () => Response.json(published))
    vi.stubGlobal("fetch", fetch)

    await expect(
      publishDocsBranch("project-1", "main", {
        expectedBaseVersionId: "version-1",
        expectedRevision: 3,
        eraseBranch: true,
      }),
    ).resolves.toEqual(published)
    expect(fetch).toHaveBeenCalledWith(
      getApiUrl("/projects/project-1/branches/main/publish"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          expectedBaseVersionId: "version-1",
          expectedRevision: 3,
          eraseBranch: true,
        }),
      }),
    )
  })

  test("surfaces the API error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: { message: "The published documentation changed." } }, { status: 409 }),
      ),
    )

    await expect(
      publishDocsBranch("project-1", "main", {
        expectedBaseVersionId: "version-1",
        expectedRevision: 3,
        eraseBranch: true,
      }),
    ).rejects.toThrow("The published documentation changed.")
  })

  test("publishes with progress from an API that answers with plain JSON", async () => {
    const published = { versionId: "version-2", versionNumber: 4, publicationId: "publication-1", branchErased: false }
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(published)))
    const onStage = vi.fn()

    await expect(
      publishDocsBranchWithProgress(
        "project-1",
        "main",
        { expectedBaseVersionId: "version-1", expectedRevision: 3, eraseBranch: true },
        onStage,
      ),
    ).resolves.toEqual(published)
    expect(onStage).not.toHaveBeenCalled()
  })

  test("fails when the stream closes before the result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response('event: stage\ndata: {"type":"stage","stage":"preparing"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    )
    const onStage = vi.fn()

    await expect(
      publishDocsBranchWithProgress(
        "project-1",
        "main",
        { expectedBaseVersionId: "version-1", expectedRevision: 3, eraseBranch: true },
        onStage,
      ),
    ).rejects.toThrow("The connection closed before the publish finished.")
    expect(onStage).toHaveBeenCalledWith("preparing")
  })
})

function createOverview(): DocsContentOverviewDto {
  return {
    projectId: "project-1",
    projectSlug: "flagforge",
    siteId: "site-1",
    publishedVersion: {
      id: "version-1",
      versionNumber: 3,
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    working: { branchId: null, baseVersionId: "v1", editedHrefs: [], changeCount: 0, revision: 0, createdAt: null, updatedAt: null, isBaseCurrent: true },
    ...overviewSiteSettings(),
    pages: [
      { href: "/", title: "Overview", sourcePath: "source/index.mdx", status: "published", icon: "compass" },
    ],
    navigation: [
      {
        slug: "default",
        label: "Docs",
        isDefault: true,
        groups: [{ heading: null, groupIndex: null, hrefs: ["/"] }],
      },
    ],
  }
}

function createPage() {
  return {
    href: "/rest-api/list flags",
    title: "List flags",
    sourcePath: "source/rest-api/list flags/index.mdx",
    status: "published" as const,
    publishedContent: "# List flags\n",
    draftContent: null,
  }
}
