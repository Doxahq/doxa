// @vitest-environment jsdom
import type { ReactNode } from "react"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { DocsContentEdit, DocsContentPageDetailDto } from "@doxahq/contracts"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { ApiRequestError } from "~/lib/api-errors"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"

const BRANCH = "55555555-5555-4555-8555-555555555555"

/** One page on an agent's branch. A save succeeds only at the current revision. */
const server = vi.hoisted(() => ({ body: "", revision: 0, saves: [] as (number | undefined)[] }))

function serverEdit(body: string) {
  server.body = body
  server.revision += 1
}

vi.mock("~/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/platform-api")>()),
  getProjectContent: async () => ({
    projectId: "p1",
    projectSlug: "example",
    siteId: "s1",
    working: { branchId: BRANCH, editedHrefs: ["/guide"], changeCount: 1, revision: server.revision },
    pages: [{ href: "/guide", title: "Guide", sourcePath: "source/guide/index.mdx", status: "edited", icon: null }],
    navigation: [{ slug: "docs", label: "Docs", isDefault: true, groups: [{ heading: null, groupIndex: null, hrefs: ["/guide"] }] }],
    siteConfig: { published: {}, working: null },
  }),
  getProjectContentPage: async (_projectId: string, href: string) =>
    ({
      href,
      title: "Guide",
      sourcePath: "source/guide/index.mdx",
      status: "edited",
      publishedContent: "",
      workingContent: server.body,
      revision: server.revision,
    }) satisfies DocsContentPageDetailDto,
  applyProjectContentEdits: async (
    _projectId: string,
    input: { edits: DocsContentEdit[]; expectedRevision?: number },
  ) => {
    server.saves.push(input.expectedRevision)
    if (input.expectedRevision !== server.revision) {
      throw new ApiRequestError(`The branch is at revision ${server.revision}.`, 409, "conflict")
    }
    const [edit] = input.edits
    if (edit?.type === "set_page_content") serverEdit(edit.content)
    return { working: { revision: server.revision }, mdxIssues: [] }
  },
  getProjectContentMdxReport: async () => ({ pages: [] }),
}))

const { useProjectContent } = await import("~/lib/dashboard/use-project-content")

async function openGuardedPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const hook = renderHook(() => useProjectContent("p1", BRANCH, { requestedHref: "/guide", guardRevision: true }), {
    wrapper,
  })
  await waitFor(() => expect(hook.result.current.text).toBe("Original\n"))
  const rereadPage = () =>
    act(() =>
      client.invalidateQueries({ queryKey: dashboardQueryKeys.contentPage("p1", BRANCH, "/guide"), exact: true }),
    )
  const rereadOverview = () =>
    act(() => client.invalidateQueries({ queryKey: dashboardQueryKeys.content("p1", BRANCH), exact: true }))
  return { hook, rereadPage, rereadOverview }
}

beforeEach(() => {
  server.body = "Original\n"
  server.revision = 3
  server.saves = []
})

afterEach(cleanup)

describe("the save guard on an agent branch", () => {
  test("sends the revision of the text that the editor loaded", async () => {
    const { hook } = await openGuardedPage()
    act(() => hook.result.current.setText("Mine\n"))
    await waitFor(() => expect(hook.result.current.isDirty).toBe(true))
    await act(() => hook.result.current.saveBuffer())
    expect(server.saves).toEqual([3])
    expect(hook.result.current.error).toBeNull()
  })

  test("a newer revision in the overview loads the newer text into a clean editor", async () => {
    const { hook, rereadOverview } = await openGuardedPage()
    serverEdit("Agent text\n")
    await rereadOverview()
    await waitFor(() => expect(hook.result.current.text).toBe("Agent text\n"))
    expect(hook.result.current.isDirty).toBe(false)
  })

  test("an edit of another page does not refuse a person's save", async () => {
    const { hook, rereadPage } = await openGuardedPage()
    act(() => hook.result.current.setText("Mine\n"))
    await waitFor(() => expect(hook.result.current.isDirty).toBe(true))
    server.revision += 1
    await rereadPage()
    await waitFor(() => expect(hook.result.current.page?.revision).toBe(4))
    await act(() => hook.result.current.saveBuffer())
    expect(server.saves).toEqual([4])
    expect(hook.result.current.text).toBe("Mine\n")
  })

  test("refuses a save over newer text, says so, and can load the latest version", async () => {
    const { hook, rereadPage } = await openGuardedPage()
    act(() => hook.result.current.setText("Mine\n"))
    await waitFor(() => expect(hook.result.current.isDirty).toBe(true))
    serverEdit("Agent text\n")
    await rereadPage()
    await waitFor(() => expect(hook.result.current.page?.revision).toBe(4))
    expect(hook.result.current.text).toBe("Mine\n")

    await act(() => hook.result.current.saveBuffer())
    expect(server.saves).toEqual([3])
    expect(server.body).toBe("Agent text\n")
    await waitFor(() => expect(hook.result.current.hasRevisionConflict).toBe(true))
    expect(hook.result.current.error).toContain("An agent changed this branch")

    await act(() => hook.result.current.loadLatestPage())
    await waitFor(() => expect(hook.result.current.text).toBe("Agent text\n"))
    expect(hook.result.current.isDirty).toBe(false)
    expect(hook.result.current.error).toBeNull()
  })
})
