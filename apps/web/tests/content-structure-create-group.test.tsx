// @vitest-environment jsdom
import type { ReactNode } from "react"
import { act, cleanup, renderHook } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { DocsContentEdit } from "@doxahq/contracts"
import { afterEach, describe, expect, test, vi } from "vitest"

const server = vi.hoisted(() => ({
  hrefs: ["/"],
  sent: [] as DocsContentEdit[],
}))

vi.mock("~/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/platform-api")>()),
  getProjectContent: async () => ({
    projectId: "p1",
    projectSlug: "example",
    siteId: "s1",
    working: { branchId: null, editedHrefs: [] },
    pages: server.hrefs.map((href) => ({
      href,
      title: href,
      sourcePath: "source/index.mdx",
      status: "published",
      icon: null,
    })),
    navigation: [],
  }),
  applyProjectContentEdits: async (_projectId: string, input: { edits: DocsContentEdit[] }) => {
    server.sent.push(...input.edits)
    server.hrefs.push("/new-page")
    return {}
  },
}))

const { useContentStructure } = await import("~/lib/dashboard/use-content-structure")
const { dashboardQueryKeys, projectContentQueryOptions } = await import("~/lib/queries/dashboard")

afterEach(cleanup)

describe("dashboard create group", () => {
  test("asks for the starter page and returns its href to open", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await client.fetchQuery(projectContentQueryOptions("p1", "main"))
    expect(client.getQueryData(dashboardQueryKeys.content("p1", "main"))).toBeDefined()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const hook = renderHook(() => useContentStructure("p1", "main"), { wrapper })

    let href: string | null = null
    await act(async () => {
      href = await hook.result.current.createGroup("docs", "Recipes")
    })

    expect(server.sent).toEqual([
      { type: "create_group", sectionSlug: "docs", heading: "Recipes", starterPage: true },
    ])
    expect(href).toBe("/new-page")
  })
})
