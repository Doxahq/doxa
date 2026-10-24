// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import type { ComponentType } from "react"
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

beforeEach(() => {
  vi.resetModules()
})

describe("dashboardPendingView", () => {
  test("draws the registered skeleton", async () => {
    const { dashboardPendingView, registerDashboardPendingViews } = await import("~/components/dashboard/pending-view")
    const { DASHBOARD_PENDING_VIEWS } = await import("~/components/dashboard/skeletons/pending-views")
    registerDashboardPendingViews({ ...DASHBOARD_PENDING_VIEWS, projectRequests: () => <p>requests skeleton</p> })
    const Pending = dashboardPendingView("projectRequests")
    render(<Pending />)
    expect(screen.getByText("requests skeleton")).toBeTruthy()
  })

  test("falls back to the shared loading label before registration", async () => {
    const { dashboardPendingView } = await import("~/components/dashboard/pending-view")
    const Pending = dashboardPendingView("projectRequests")
    render(<Pending />)
    expect(screen.getByRole("status").textContent).toBe("Loading page")
  })

  // Every dashboard route renders inside the dashboard layout, so loading the
  // layout code must register the views before any route needs one.
  test("loading the dashboard layout registers every view", async () => {
    await import("~/components/dashboard/dashboard-layout")
    const { dashboardPendingView } = await import("~/components/dashboard/pending-view")
    const Pending = dashboardPendingView("projectRequests")
    render(<Pending />)
    // The requests page skeleton, not the shared loading label.
    expect(screen.getByRole("status").textContent).toContain("Loading requests")
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Agent requests")
    expect(screen.queryByText("Loading page")).toBeNull()
  }, 60_000)
})

describe("a dashboard route that loads before its layout code", () => {
  test("shows its own skeleton, never the fallback label", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined)
    const router = await import("@tanstack/react-router")
    const { dashboardPendingView, registerDashboardPendingViews } = await import("~/components/dashboard/pending-view")
    const { DASHBOARD_PENDING_VIEWS } = await import("~/components/dashboard/skeletons/pending-views")
    const { projectPagePending } = await import("~/components/dashboard/route-pending")

    // The layout module registers the views when its code runs, like dashboard-layout.tsx.
    let finishLayout!: () => void
    const layoutModule = new Promise<{ default: ComponentType }>((resolve) => {
      finishLayout = () => {
        registerDashboardPendingViews({ ...DASHBOARD_PENDING_VIEWS, projectRequests: () => <p role="status">requests skeleton</p> })
        resolve({ default: () => <router.Outlet /> })
      }
    })
    let finishPage!: () => void
    const pageModule = new Promise<{ default: ComponentType }>((resolve) => {
      finishPage = () => resolve({ default: () => <h1>Requests</h1> })
    })

    const root = router.createRootRoute({ component: () => <router.Outlet /> })
    const home = router.createRoute({ getParentRoute: () => root, path: "/", component: () => <h1>Home</h1> })
    const dashboard = router.createRoute({
      getParentRoute: () => root,
      path: "/dashboard",
      component: router.lazyRouteComponent(() => layoutModule),
    })
    const requests = router.createRoute({
      getParentRoute: () => dashboard,
      path: "/requests",
      ...projectPagePending,
      pendingComponent: dashboardPendingView("projectRequests"),
      component: router.lazyRouteComponent(() => pageModule),
    })
    const app = router.createRouter({
      routeTree: root.addChildren([home, dashboard.addChildren([requests])]),
      history: router.createMemoryHistory({ initialEntries: ["/"] }),
    })
    const seen = new Set<string>()
    const observer = new MutationObserver(() => {
      for (const status of document.querySelectorAll("[role=status]")) seen.add(status.textContent ?? "")
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    render(<router.RouterProvider router={app} />)
    await screen.findByText("Home")

    act(() => app.history.push("/dashboard/requests"))
    // Well past the pending delay, the layout code is still loading.
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)))
    act(() => finishLayout())
    expect(await screen.findByText("requests skeleton")).toBeTruthy()
    await act(async () => finishPage())
    await screen.findByRole("heading", { name: "Requests" }, { timeout: 2_000 })
    observer.disconnect()

    expect(seen.has("Loading page")).toBe(false)
  })
})

describe("dashboard route files", () => {
  // The router keeps `pendingComponent` (and `loader`) in the main bundle,
  // which the marketing pages share. A skeleton imported by a route file
  // brings the dashboard shell, the API client and zod into that bundle.
  test("name their pending view instead of importing a skeleton or a query module", () => {
    const root = join(__dirname, "../src/routes/dashboard")
    const offenders = walk(root).filter((file) =>
      /from "~\/(components\/dashboard\/(skeletons\/|content\/editor-skeleton|generation-changes\/generation-changes-pending)|lib\/queries\/|lib\/platform-api)/.test(
        readFileSync(file, "utf8"),
      ),
    )
    expect(offenders.map((file) => relative(root, file))).toEqual([])
  })
})

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}
