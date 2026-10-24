// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider, useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const api = vi.hoisted(() => ({
  getProjectShell: vi.fn(),
  getProject: vi.fn(),
  listPendingMerges: vi.fn(),
  getProjectDoxabotSettings: vi.fn(),
  listProjectGenerations: vi.fn(),
  listDocsDomains: vi.fn(),
  getGenerationReview: vi.fn(),
  listDocsBranches: vi.fn(),
  listApprovalRequests: vi.fn(),
}))

vi.mock("~/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/platform-api")>()),
  getProjectShell: api.getProjectShell,
  getProject: api.getProject,
  listPendingMerges: api.listPendingMerges,
  getProjectDoxabotSettings: api.getProjectDoxabotSettings,
  listProjectGenerations: api.listProjectGenerations,
  listDocsDomains: api.listDocsDomains,
}))
vi.mock("~/lib/generation-review-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/generation-review-api")>()),
  getGenerationReview: api.getGenerationReview,
}))
vi.mock("~/lib/docs-branches-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/docs-branches-api")>()),
  listDocsBranches: api.listDocsBranches,
}))
vi.mock("~/lib/approval-requests-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/approval-requests-api")>()),
  listApprovalRequests: api.listApprovalRequests,
}))

const {
  dashboardQueryKeys,
  docsDomainsQueryOptions,
  pendingMergesQueryOptions,
  projectDetailQueryOptions,
  projectDoxabotQueryOptions,
  projectGenerationsQueryOptions,
} = await import("~/lib/queries/dashboard")
const { generationReviewQueryOptions } = await import("~/lib/queries/generation-review")
const { docsBranchListQueryOptions } = await import("~/lib/queries/docs-branches")
const { approvalRequestListQueryOptions } = await import("~/lib/queries/approval-requests")
const { readShellSections } = await import("~/lib/queries/project-shell")

const P = "p1"
const detail = {
  project: { id: P, name: "Flagforge", slug: "flagforge", githubRepositoryId: null, repositoryFullName: null, publishedVersionId: null, docsUrl: null, team: null },
  latestJob: null,
  role: "owner",
}
const settings = {
  enabled: true,
  mergeTrigger: "manual",
  batchQuietMinutes: 15,
  repositoryVisibility: null,
  updatedAt: null,
  available: true,
  unavailableReason: null,
}
const generationsPage = { generations: [], nextCursor: "cursor-2" }
const branches = { branches: [], maxBranchesPerSite: 10 }
const pending = { requests: [] }
const domains = { domains: [], customDomainLimit: 3 }

function shellBody(overrides: Record<string, unknown> = {}) {
  return {
    project: { data: detail },
    generationReview: { data: { review: null } },
    pendingMerges: { data: { merges: [] } },
    doxabot: { data: { settings } },
    generations: { data: generationsPage },
    branches: { data: branches },
    pendingApprovalRequests: { data: pending },
    docsDomains: { data: domains },
    ...overrides,
  }
}

/** What each section's own endpoint returns, after its API function. */
function answerOwnEndpoints() {
  api.getProject.mockResolvedValue(detail)
  api.getGenerationReview.mockResolvedValue(null)
  api.listPendingMerges.mockResolvedValue([])
  api.getProjectDoxabotSettings.mockResolvedValue(settings)
  api.listProjectGenerations.mockResolvedValue(generationsPage)
  api.listDocsBranches.mockResolvedValue(branches)
  api.listApprovalRequests.mockResolvedValue(pending)
  api.listDocsDomains.mockResolvedValue(domains)
}

const ownEndpoints = () => [
  api.getProject,
  api.getGenerationReview,
  api.listPendingMerges,
  api.getProjectDoxabotSettings,
  api.listProjectGenerations,
  api.listDocsBranches,
  api.listApprovalRequests,
  api.listDocsDomains,
]

let client: QueryClient
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  answerOwnEndpoints()
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

/** The Overview's first load: the layout's and the page's queries, all at once. */
function loadOverview() {
  return Promise.all([
    client.fetchQuery(projectDetailQueryOptions(P)),
    client.fetchQuery(docsBranchListQueryOptions(P)),
    client.fetchQuery(approvalRequestListQueryOptions(P, "pending")),
    client.fetchQuery(generationReviewQueryOptions(P)),
    client.fetchQuery(pendingMergesQueryOptions(P)),
    client.fetchQuery(projectDoxabotQueryOptions(P)),
    client.fetchInfiniteQuery(projectGenerationsQueryOptions(P)),
  ])
}

describe("the project shell", () => {
  test("one shell request fills every query, with no request of its own", async () => {
    api.getProjectShell.mockResolvedValue(shellBody())
    const before = Date.now()
    const [project, branchList, pendingList, review, merges, doxabot, generations] = await loadOverview()

    expect(api.getProjectShell).toHaveBeenCalledTimes(1)
    for (const endpoint of ownEndpoints()) expect(endpoint).not.toHaveBeenCalled()
    expect(project).toEqual(detail)
    expect(branchList).toEqual(branches)
    expect(pendingList).toEqual(pending)
    expect(review).toBeNull()
    expect(merges).toEqual([])
    expect(doxabot).toEqual(settings)
    expect(generations).toEqual({ pages: [generationsPage], pageParams: [null] })

    // The domains query had not loaded yet. The shell filled it, with the
    // time of the answer, so its stale time counts from then.
    const domainsState = client.getQueryState(dashboardQueryKeys.domains(P))
    expect(domainsState?.data).toEqual(domains)
    expect(domainsState?.dataUpdatedAt).toBeGreaterThanOrEqual(before)
    await client.fetchQuery(docsDomainsQueryOptions(P))
    expect(api.listDocsDomains).not.toHaveBeenCalled()
  })

  test("queries that mount while the shell is in flight wait for it", async () => {
    let answer!: (body: unknown) => void
    api.getProjectShell.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const hook = renderHook(
      () => ({
        project: useQuery(projectDetailQueryOptions(P)),
        review: useQuery(generationReviewQueryOptions(P)),
        merges: useQuery(pendingMergesQueryOptions(P)),
        doxabot: useQuery(projectDoxabotQueryOptions(P)),
        generations: useInfiniteQuery(projectGenerationsQueryOptions(P)),
        branches: useQuery(docsBranchListQueryOptions(P)),
        pending: useQuery(approvalRequestListQueryOptions(P, "pending")),
      }),
      { wrapper },
    )
    await waitFor(() => expect(api.getProjectShell).toHaveBeenCalledTimes(1))
    // A second mount of the same queries joins the same request.
    renderHook(() => useQuery(projectDoxabotQueryOptions(P)), { wrapper })

    answer(shellBody())
    await waitFor(() => expect(hook.result.current.generations.data?.pages).toEqual([generationsPage]))
    expect(hook.result.current.project.data).toEqual(detail)
    expect(api.getProjectShell).toHaveBeenCalledTimes(1)
    for (const endpoint of ownEndpoints()) expect(endpoint).not.toHaveBeenCalled()
  })

  test("a section with an error falls back to its own endpoint, and only that one", async () => {
    api.getProjectShell.mockResolvedValue(
      shellBody({
        generations: { error: { status: 504, message: "This section did not answer in time.", details: { code: "timeout" } } },
        doxabot: { error: { status: 403, message: "Forbidden" } },
      }),
    )
    const results = await loadOverview()

    expect(api.listProjectGenerations).toHaveBeenCalledTimes(1)
    expect(api.listProjectGenerations).toHaveBeenCalledWith(P, { limit: 20, cursor: null })
    expect(api.getProjectDoxabotSettings).toHaveBeenCalledTimes(1)
    expect(results[6]).toEqual({ pages: [generationsPage], pageParams: [null] })
    expect(results[5]).toEqual(settings)
    for (const endpoint of [api.getProject, api.getGenerationReview, api.listPendingMerges, api.listDocsBranches]) {
      expect(endpoint).not.toHaveBeenCalled()
    }
  })

  test("a section whose data breaks the contract falls back as well", () => {
    const sections = readShellSections(shellBody({ branches: { data: { branches: "nope" } } }))
    expect(sections.branches).toBeUndefined()
    expect(sections.project).toEqual(detail)
  })

  test("a failed shell request falls back to every endpoint", async () => {
    api.getProjectShell.mockRejectedValue(new Error("Request failed (500)"))
    await loadOverview()

    expect(api.getProjectShell).toHaveBeenCalledTimes(1)
    for (const endpoint of ownEndpoints().filter((endpoint) => endpoint !== api.listDocsDomains)) {
      expect(endpoint).toHaveBeenCalledTimes(1)
    }
  })

  test("an invalidation refetches the one endpoint, not the shell", async () => {
    api.getProjectShell.mockResolvedValue(shellBody())
    await loadOverview()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    renderHook(() => useQuery(projectDoxabotQueryOptions(P)), { wrapper })

    await client.invalidateQueries({ queryKey: dashboardQueryKeys.doxabot(P) })

    await waitFor(() => expect(api.getProjectDoxabotSettings).toHaveBeenCalledTimes(1))
    expect(api.getProjectShell).toHaveBeenCalledTimes(1)
  })

  test("the next generations page comes from the endpoint", async () => {
    api.getProjectShell.mockResolvedValue(shellBody())
    await loadOverview()
    api.listProjectGenerations
      .mockResolvedValueOnce(generationsPage)
      .mockResolvedValueOnce({ generations: [], nextCursor: null })

    // A refetch of the loaded query, with a second page: both pages come from the endpoint.
    await client.fetchInfiniteQuery({ ...projectGenerationsQueryOptions(P), pages: 2, staleTime: 0 })
    expect(api.listProjectGenerations.mock.calls).toEqual([
      [P, { limit: 20, cursor: null }],
      [P, { limit: 20, cursor: "cursor-2" }],
    ])
    expect(api.getProjectShell).toHaveBeenCalledTimes(1)
  })

  test("a save that lands while the shell runs keeps its newer data", async () => {
    let answer!: (body: unknown) => void
    api.getProjectShell.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const loading = client.fetchQuery(projectDetailQueryOptions(P))
    await waitFor(() => expect(api.getProjectShell).toHaveBeenCalledTimes(1))
    const saved = { enabled: false }
    await new Promise((resolve) => setTimeout(resolve, 2))
    client.setQueryData(dashboardQueryKeys.doxabot(P), saved)

    answer(shellBody())
    await loading
    expect(client.getQueryData(dashboardQueryKeys.doxabot(P))).toBe(saved)
  })
})
