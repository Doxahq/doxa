import { QueryClient, environmentManager } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { contentPageHrefFromSearch, startProjectPrefetch } from "~/lib/dashboard/project-route-prefetch"
import { approvalRequestListQueryOptions } from "~/lib/queries/approval-requests"
import {
  pendingMergesQueryOptions,
  projectContentPageQueryOptions,
  projectContentQueryOptions,
  projectDetailQueryOptions,
  projectDoxabotQueryOptions,
  projectGenerationCacheQueryOptions,
  projectGenerationsQueryOptions,
} from "~/lib/queries/dashboard"
import { docsBranchListQueryOptions } from "~/lib/queries/docs-branches"
import { generationReviewQueryOptions } from "~/lib/queries/generation-review"
import { prefetchProjectPage, type ProjectPrefetchPage } from "~/lib/queries/project-prefetch"

/** Every request hangs until the test ends, so the cache shows what started. */
const hang = () => new Promise<Response>(() => undefined)
const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => hang())

const DRAFT_BRANCH = "6f1c2a4e-8b3d-4e5f-9a7b-0c1d2e3f4a5b"

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function startedKeys(client: QueryClient): string[] {
  return client.getQueryCache().getAll().map((query) => query.queryHash).sort()
}

function hashes(...keys: (readonly unknown[])[]): string[] {
  return keys.map((key) => JSON.stringify(key)).sort()
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(hang)
  vi.stubGlobal("fetch", fetchMock)
  environmentManager.setIsServer(() => false)
})

afterEach(() => {
  vi.unstubAllGlobals()
  environmentManager.setIsServer(() => typeof window === "undefined")
})

describe("prefetchProjectPage", () => {
  // The page finds the request only if the key is the one its `useQuery` uses.
  // The project shell's sections share one shell request (see
  // `lib/queries/project-shell.ts`), so the last column counts requests.
  test.each<[ProjectPrefetchPage, string[], number]>([
    [
      "workspace",
      hashes(projectDetailQueryOptions("p1").queryKey, docsBranchListQueryOptions("p1").queryKey),
      1,
    ],
    [
      "overview",
      hashes(
        generationReviewQueryOptions("p1").queryKey,
        pendingMergesQueryOptions("p1").queryKey,
        projectDoxabotQueryOptions("p1").queryKey,
        projectGenerationsQueryOptions("p1").queryKey,
      ),
      1,
    ],
    [
      "generations",
      hashes(projectGenerationsQueryOptions("p1").queryKey, generationReviewQueryOptions("p1").queryKey),
      1,
    ],
    ["requests", hashes(approvalRequestListQueryOptions("p1", undefined).queryKey), 1],
    [
      "settings",
      hashes(projectGenerationCacheQueryOptions("p1").queryKey, projectDoxabotQueryOptions("p1").queryKey),
      2,
    ],
  ])("%s starts the page's queries with the page's keys", async (page, expected, requests) => {
    const client = makeClient()
    void prefetchProjectPage(client, page, { projectId: "p1" })
    expect(startedKeys(client)).toEqual(expected)
    // The shell request starts after the query modules' first microtasks.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(requests))
  })

  test("content starts the overview and the page from the URL, on the branch this browser chose", () => {
    vi.stubGlobal("localStorage", { getItem: (key: string) => (key === "doxa:docs-branch:p1" ? DRAFT_BRANCH : null) })
    const client = makeClient()
    void prefetchProjectPage(client, "content", { projectId: "p1", contentPageHref: "/guides/setup" })
    expect(startedKeys(client)).toEqual(
      hashes(
        projectContentQueryOptions("p1", DRAFT_BRANCH).queryKey,
        projectContentPageQueryOptions("p1", DRAFT_BRANCH, "/guides/setup").queryKey,
      ),
    )
  })

  test("content without a page in the URL starts only the overview, on main when nothing is saved", () => {
    vi.stubGlobal("localStorage", { getItem: () => null })
    const client = makeClient()
    void prefetchProjectPage(client, "content", { projectId: "p1", contentPageHref: null })
    expect(startedKeys(client)).toEqual(hashes(projectContentQueryOptions("p1", "main").queryKey))
  })

  test("the project layout and the Overview send one shell request together", async () => {
    const client = makeClient()
    void prefetchProjectPage(client, "workspace", { projectId: "p1" })
    void prefetchProjectPage(client, "overview", { projectId: "p1" })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const urls = fetchMock.mock.calls.map(([input]) => String(input))
    expect(urls).toEqual([expect.stringMatching(/\/projects\/p1\/shell$/)])
  })

  test("a query that has data is left to the page: no request", () => {
    const client = makeClient()
    client.setQueryData(projectDetailQueryOptions("p1").queryKey, { latestJob: null, role: "owner" } as never)
    client.setQueryData(docsBranchListQueryOptions("p1").queryKey, { branches: [], maxBranchesPerSite: 3 })
    void prefetchProjectPage(client, "workspace", { projectId: "p1" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("a query that is already loading is shared, not sent twice", () => {
    const client = makeClient()
    void prefetchProjectPage(client, "settings", { projectId: "p1" })
    void prefetchProjectPage(client, "settings", { projectId: "p1" })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("a failed request settles the prefetch without throwing", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("offline")))
    const client = makeClient()
    const results = await prefetchProjectPage(client, "requests", { projectId: "p1" })
    expect(results.map((result) => result.status)).toEqual(["rejected"])
  })
})

describe("startProjectPrefetch", () => {
  test("returns at once and starts the requests in the background", async () => {
    const client = makeClient()
    expect(startProjectPrefetch(client, "requests", { projectId: "p1" })).toBeUndefined()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    // The request still hangs: the caller never waited for it.
    expect(client.getQueryState(approvalRequestListQueryOptions("p1").queryKey)?.fetchStatus).toBe("fetching")
  })

  test("starts nothing on the server", async () => {
    environmentManager.setIsServer(() => true)
    const client = makeClient()
    startProjectPrefetch(client, "overview", { projectId: "p1" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(client.getQueryCache().getAll()).toEqual([])
  })
})

describe("contentPageHrefFromSearch", () => {
  test("takes the page like the route's search validation", () => {
    expect(contentPageHrefFromSearch({ page: "/guides/setup" })).toBe("/guides/setup")
    expect(contentPageHrefFromSearch({ page: "guides" })).toBeNull()
    expect(contentPageHrefFromSearch({ page: 3 })).toBeNull()
    expect(contentPageHrefFromSearch({})).toBeNull()
    expect(contentPageHrefFromSearch(undefined)).toBeNull()
  })
})
