// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import type { ProjectDto } from "@doxahq/contracts"
import { afterEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listRepositories: vi.fn(),
}))

vi.mock("~/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/platform-api")>()),
  listProjects: mocks.listProjects,
  listRepositories: mocks.listRepositories,
}))

const {
  dashboardQueryKeys,
  githubRepositoriesQueryOptions,
  projectsListQueryOptions,
} = await import("~/lib/queries/dashboard")
const { useProjectsSummary } = await import("~/lib/dashboard/use-projects-summary")
const { mergeProjectIntoList, removeProjectFromList } = await import("~/lib/dashboard/cache")

const project = (id: string) => ({ id, name: id }) as ProjectDto

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

describe("the account lists", () => {
  test("projects and repositories have their own keys under the summary key", () => {
    const summary = dashboardQueryKeys.summary()
    expect(dashboardQueryKeys.projects().slice(0, summary.length)).toEqual(summary)
    expect(dashboardQueryKeys.githubRepositories().slice(0, summary.length)).toEqual(summary)
    expect(dashboardQueryKeys.projects()).not.toEqual(dashboardQueryKeys.githubRepositories())
  })

  test("an invalidation of the summary key, as every project mutation sends, refreshes both lists", async () => {
    const client = new QueryClient()
    client.setQueryData(dashboardQueryKeys.projects(), [project("p1")])
    client.setQueryData(dashboardQueryKeys.githubRepositories(), { repositories: [], error: null })

    await client.invalidateQueries({ queryKey: dashboardQueryKeys.summary() })

    expect(client.getQueryState(dashboardQueryKeys.projects())?.isInvalidated).toBe(true)
    expect(client.getQueryState(dashboardQueryKeys.githubRepositories())?.isInvalidated).toBe(true)
  })

  test("the projects list stays fresh for minutes", () => {
    expect(projectsListQueryOptions().staleTime).toBeGreaterThanOrEqual(5 * 60_000)
  })

  test("the projects list asks for nothing but the projects", async () => {
    mocks.listProjects.mockResolvedValue([project("p1")])
    const client = new QueryClient()
    await client.fetchQuery(projectsListQueryOptions())

    expect(mocks.listProjects).toHaveBeenCalledTimes(1)
    expect(mocks.listRepositories).not.toHaveBeenCalled()
  })

  test("a failed repository list is a result with an error, not a failed query", async () => {
    mocks.listRepositories.mockRejectedValue(new Error("GitHub is down."))
    const client = new QueryClient()

    await expect(client.fetchQuery(githubRepositoriesQueryOptions())).resolves.toEqual({
      repositories: [],
      error: "GitHub is down.",
    })
  })

  test("project cache helpers put a changed project first and remove a deleted one", () => {
    const list = [project("a"), project("b")]
    expect(mergeProjectIntoList(list, project("b"))?.map(({ id }) => id)).toEqual(["b", "a"])
    expect(mergeProjectIntoList(list, project("c"))?.map(({ id }) => id)).toEqual(["c", "a", "b"])
    expect(removeProjectFromList(list, "a")?.map(({ id }) => id)).toEqual(["b"])
    expect(mergeProjectIntoList(undefined, project("c"))).toBeUndefined()
  })
})

describe("useProjectsSummary", () => {
  test("reads the projects without the repositories", async () => {
    mocks.listProjects.mockResolvedValue([project("p1")])
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const hook = renderHook(() => useProjectsSummary(), { wrapper: wrapperFor(client) })

    await waitFor(() => expect(hook.result.current.projects.map(({ id }) => id)).toEqual(["p1"]))
    expect(mocks.listRepositories).not.toHaveBeenCalled()
  })

  test("with refetchOnMount false, a mount reads stale cached projects with no request (⌘K)", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(dashboardQueryKeys.projects(), [project("p1")], { updatedAt: 0 })
    mocks.listProjects.mockResolvedValue([project("p2")])

    const menu = renderHook(() => useProjectsSummary({ refetchOnMount: false }), { wrapper: wrapperFor(client) })
    expect(menu.result.current.projects.map(({ id }) => id)).toEqual(["p1"])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(mocks.listProjects).not.toHaveBeenCalled()

    // The default still refetches stale data on mount.
    renderHook(() => useProjectsSummary(), { wrapper: wrapperFor(client) })
    await waitFor(() => expect(mocks.listProjects).toHaveBeenCalledTimes(1))
  })
})
