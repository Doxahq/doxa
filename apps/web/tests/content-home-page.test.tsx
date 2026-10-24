// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import { afterEach, expect, test, vi } from "vitest"
import type { DocsContentOverviewDto } from "@doxahq/contracts"
import { resolveSiteConfig } from "@doxahq/site-config"

const api = vi.hoisted(() => ({
  finishEdit: () => undefined as void,
  finishRefetch: (_overview: unknown) => undefined as void,
}))
vi.mock("~/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyProjectContentEdits: () =>
    new Promise((resolve) => {
      api.finishEdit = () => resolve({ mdxIssues: [] })
    }),
  getProjectContent: () =>
    new Promise((resolve) => {
      api.finishRefetch = resolve
    }),
}))

import { contentHomeHref } from "~/lib/dashboard/content-navigation"
import { useContentStructure, type ContentStructureActions } from "~/lib/dashboard/use-content-structure"
import { dashboardQueryKeys, projectContentQueryOptions } from "~/lib/queries/dashboard"

afterEach(cleanup)

const key = dashboardQueryKeys.content("p1", "main")
const page = (href: string) => ({ href, title: href, status: "published" as const, sourcePath: "", icon: null })
// The parts of the overview that the default page reads.
const overview = {
  pages: [page("/"), page("/b")],
  navigation: [
    { slug: "default", label: "Docs", isDefault: true, groups: [{ heading: null, groupIndex: null, hrefs: ["/", "/b"] }] },
  ],
  siteConfig: { published: resolveSiteConfig({}), working: null },
} as unknown as DocsContentOverviewDto

let structure: ContentStructureActions

function Probe() {
  const data = useQuery({ ...projectContentQueryOptions("p1", "main"), staleTime: Infinity }).data
  structure = useContentStructure("p1", "main")
  const home = data ? contentHomeHref(data.pages, data.navigation, data.siteConfig) : null
  return (
    <span data-testid="home">
      {home}
      {structure.pendingHomeHref ? " pending" : ""}
    </span>
  )
}

function renderProbe() {
  const client = new QueryClient()
  client.setQueryData(key, overview)
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  )
  return client
}

test("the new default shows at once, pending until the server answers", async () => {
  renderProbe()
  expect(screen.getByTestId("home").textContent).toBe("/")

  await act(async () => {
    void structure.setHomePage("/b")
  })
  expect(screen.getByTestId("home").textContent).toBe("/b pending")

  await act(async () => api.finishEdit())
  expect(screen.getByTestId("home").textContent).toBe("/b")
})

test("a refetch that started before the choice cannot bring the old default back", async () => {
  const client = renderProbe()
  await act(async () => {
    void client.refetchQueries({ queryKey: key })
  })
  await act(async () => {
    void structure.setHomePage("/b")
  })
  // The old answer arrives after the choice. The cancelled refetch drops it.
  await act(async () => api.finishRefetch(overview))
  expect(screen.getByTestId("home").textContent).toBe("/b pending")
})
