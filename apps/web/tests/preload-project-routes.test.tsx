// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const loadRouteChunk = vi.fn()
const { loadWriteEditor } = vi.hoisted(() => ({ loadWriteEditor: vi.fn() }))
const routesById = Object.fromEntries(
  [
    "__root__",
    "/dashboard",
    "/dashboard/projects/$projectId",
    "/dashboard/projects/$projectId/project",
    "/dashboard/projects/$projectId/content",
    "/dashboard/projects/$projectId/generations/",
    "/dashboard/projects/$projectId/generations/$generationId",
    "/dashboard/projects/$projectId/requests/",
    "/dashboard/projects/$projectId/requests/$requestId",
    "/dashboard/projects/$projectId/settings/",
    "/dashboard/projects/$projectId/settings/approvals",
    "/dashboard/projects/$projectId/site",
    "/dashboard/projects/$projectId/site/",
    "/dashboard/projects/$projectId/site/appearance",
    "/dashboard/projects/$projectId/site/advanced",
    "/dashboard/projects/$projectId/sitemap",
  ].map((id) => [id, { id }]),
)
let settle: (() => void) | null = null

vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ routesById, loadRouteChunk }) }))
vi.mock("~/lib/when-page-settles", () => ({
  whenPageSettles: (task: () => void) => {
    settle = task
    return () => {
      settle = null
    }
  },
}))
vi.mock("~/components/dashboard/content/write-editor/write-editor", () => {
  loadWriteEditor()
  return { default: () => null }
})

beforeEach(() => {
  vi.resetModules()
  loadRouteChunk.mockClear()
  loadWriteEditor.mockClear()
  settle = null
})

afterEach(cleanup)

async function renderHookOnce() {
  const { usePreloadProjectRoutes } = await import("~/lib/dashboard/use-preload-project-routes")
  function Host() {
    usePreloadProjectRoutes()
    return null
  }
  return render(<Host />)
}

describe("usePreloadProjectRoutes", () => {
  test("loads nothing before the page settles", async () => {
    await renderHookOnce()
    expect(loadRouteChunk).not.toHaveBeenCalled()
    expect(loadWriteEditor).not.toHaveBeenCalled()
  })

  test("loads the main project pages, the site settings sections and the Write editor once the page settles", async () => {
    await renderHookOnce()
    settle?.()
    expect(loadRouteChunk.mock.calls.map(([route]) => route.id)).toEqual([
      "/dashboard/projects/$projectId/project",
      "/dashboard/projects/$projectId/content",
      "/dashboard/projects/$projectId/generations/",
      "/dashboard/projects/$projectId/requests/",
      "/dashboard/projects/$projectId/settings/",
      "/dashboard/projects/$projectId/site",
      "/dashboard/projects/$projectId/site/",
      "/dashboard/projects/$projectId/site/appearance",
      "/dashboard/projects/$projectId/site/advanced",
    ])
    // The module mock runs once per file, and this is the first test that loads it.
    await vi.waitFor(() => expect(loadWriteEditor).toHaveBeenCalledTimes(1))
  })

  test("runs once per page load", async () => {
    const { usePreloadProjectRoutes } = await import("~/lib/dashboard/use-preload-project-routes")
    function Host() {
      usePreloadProjectRoutes()
      return null
    }
    const view = render(<Host />)
    settle?.()
    view.unmount()
    render(<Host />)
    expect(settle).toBeNull()
    expect(loadRouteChunk).toHaveBeenCalledTimes(9)
  })
})

describe("isPreloadedProjectRoute", () => {
  test("matches the sidebar pages and site settings, not detail pages or look-alike paths", async () => {
    const { isPreloadedProjectRoute } = await import("~/lib/dashboard/use-preload-project-routes")
    expect(isPreloadedProjectRoute("/dashboard/projects/$projectId/content")).toBe(true)
    expect(isPreloadedProjectRoute("/dashboard/projects/$projectId/site/seo")).toBe(true)
    expect(isPreloadedProjectRoute("/dashboard/projects/$projectId/sitemap")).toBe(false)
    expect(isPreloadedProjectRoute("/dashboard/projects/$projectId/generations/$generationId")).toBe(false)
    expect(isPreloadedProjectRoute("/dashboard/projects/$projectId")).toBe(false)
  })
})
