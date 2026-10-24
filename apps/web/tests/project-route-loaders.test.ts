import { QueryClient, environmentManager } from "@tanstack/react-query"
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"

import { approvalRequestListQueryOptions } from "~/lib/queries/approval-requests"
import { projectContentPageQueryOptions, projectDetailQueryOptions } from "~/lib/queries/dashboard"
import type { createRouter as CreateRouter } from "~/router"

const hang = () => new Promise<Response>(() => undefined)
const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => hang())

let createRouter: typeof CreateRouter

// The route tree imports every page, so it loads once for the whole file.
beforeAll(async () => {
  ;({ createRouter } = await import("~/router"))
}, 60_000)

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(hang)
  vi.stubGlobal("fetch", fetchMock)
  vi.stubGlobal("localStorage", { getItem: () => null })
  environmentManager.setIsServer(() => false)
})

afterEach(() => {
  vi.unstubAllGlobals()
  environmentManager.setIsServer(() => typeof window === "undefined")
})

type Loader = (ctx: unknown) => unknown

function loaderOf(router: ReturnType<typeof CreateRouter>, routeId: string): Loader {
  const loader = (router.routesById as unknown as Record<string, { options: { loader?: unknown } }>)[routeId]?.options.loader
  if (typeof loader !== "function") throw new Error(`${routeId} has no loader`)
  return loader as Loader
}

/** A page whose code arrives when the test calls `finish`. */
function slowPageCode() {
  let finish!: () => void
  const loaded = new Promise<void>((resolve) => {
    finish = resolve
  })
  return { route: { options: { component: { preload: () => loaded } } }, finish }
}

async function settled(promise: unknown): Promise<boolean> {
  let done = false
  void Promise.resolve(promise).then(() => {
    done = true
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  return done
}

describe("router", () => {
  test("puts the QueryClient in the route context", () => {
    const queryClient = new QueryClient()
    const router = createRouter(queryClient)
    expect(router.options.context).toEqual({ queryClient })
    expect(router.options.defaultPreload).toBe("intent")
  })

  // A hover preload must run the loader each time, so TanStack Query decides freshness.
  test.each([
    "/dashboard/projects/$projectId",
    "/dashboard/projects/$projectId/project",
    "/dashboard/projects/$projectId/content",
    "/dashboard/projects/$projectId/generations/",
    "/dashboard/projects/$projectId/requests/",
    "/dashboard/projects/$projectId/settings/",
  ])("%s has a loader and no preload cache", (routeId) => {
    const router = createRouter(new QueryClient())
    const options = (router.routesById as unknown as Record<string, { options: { preloadStaleTime?: number } }>)[routeId]?.options
    expect(options?.preloadStaleTime).toBe(0)
    expect(loaderOf(router, routeId)).toBeTypeOf("function")
  })
})

describe("project route loaders", () => {
  test("a page loader starts the requests and waits only for the page code", async () => {
    const queryClient = new QueryClient()
    const router = createRouter(queryClient)
    const page = slowPageCode()
    const result = loaderOf(router, "/dashboard/projects/$projectId/requests/")({
      ...page,
      context: { queryClient },
      params: { projectId: "p1" },
      location: { search: {} },
    })

    // The request is out while the page code is still loading.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(queryClient.getQueryState(approvalRequestListQueryOptions("p1").queryKey)?.fetchStatus).toBe("fetching")
    expect(await settled(result)).toBe(false)

    // The code arrives; the request still hangs, and the loader is done.
    page.finish()
    expect(await settled(result)).toBe(true)
    expect(queryClient.getQueryState(approvalRequestListQueryOptions("p1").queryKey)?.fetchStatus).toBe("fetching")
  })

  test("the content loader starts the page from the URL", async () => {
    const queryClient = new QueryClient()
    const router = createRouter(queryClient)
    const page = slowPageCode()
    void loaderOf(router, "/dashboard/projects/$projectId/content")({
      ...page,
      context: { queryClient },
      params: { projectId: "p1" },
      location: { search: { page: "/guides/setup" } },
    })
    await vi.waitFor(() =>
      expect(queryClient.getQueryState(projectContentPageQueryOptions("p1", "main", "/guides/setup").queryKey)).toBeDefined(),
    )
    page.finish()
  })

  test("the project layout loader returns at once and starts the shell's requests", async () => {
    const queryClient = new QueryClient()
    const router = createRouter(queryClient)
    const result = loaderOf(router, "/dashboard/projects/$projectId")({
      context: { queryClient },
      params: { projectId: "p1" },
    })
    expect(result).toBeUndefined()
    await vi.waitFor(() =>
      expect(queryClient.getQueryState(projectDetailQueryOptions("p1").queryKey)?.fetchStatus).toBe("fetching"),
    )
  })

  test("the server starts nothing", async () => {
    environmentManager.setIsServer(() => true)
    const queryClient = new QueryClient()
    const router = createRouter(queryClient)
    const page = slowPageCode()
    page.finish()
    await loaderOf(router, "/dashboard/projects/$projectId/project")({
      ...page,
      context: { queryClient },
      params: { projectId: "p1" },
      location: { search: {} },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
