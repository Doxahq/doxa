// @vitest-environment jsdom
import type { ComponentType } from "react"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  RouterProvider,
  type RouteComponent,
} from "@tanstack/react-router"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { projectCrumbs } from "~/components/dashboard/project-workspace-layout"
import { projectPagePending } from "~/components/dashboard/route-pending"
import { useIsProjectPagePending } from "~/lib/dashboard/use-project-page-pending"
import { useRenderedPathname } from "~/lib/dashboard/use-rendered-pathname"

// The router restores scroll after a navigation. jsdom has no scrolling.
beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

type PageModule = { default: ComponentType }

/** A page whose code arrives when the test calls `finish`. */
function slowPage(title: string) {
  let finish!: () => void
  const module = new Promise<PageModule>((resolve) => {
    finish = () => resolve({ default: () => <h1>{title}</h1> })
  })
  return { component: lazyRouteComponent(() => module), finish: () => act(async () => finish()) }
}

/** What the shell reads: the page path it follows, and whether the page is loading. */
function ShellProbe() {
  const pathname = useRenderedPathname()
  const isPending = useIsProjectPagePending()
  return <p data-testid="shell">{`${pathname} ${isPending ? "loading" : "ready"}`}</p>
}

function renderProject(pages: { slow: RouteComponent; quick: RouteComponent }) {
  const root = createRootRoute({
    component: () => (
      <>
        <ShellProbe />
        <Outlet />
      </>
    ),
  })
  const project = createRoute({ getParentRoute: () => root, path: "/dashboard/projects/$projectId" })
  const overview = createRoute({
    getParentRoute: () => project,
    path: "/project",
    ...projectPagePending,
    component: () => <h1>Overview</h1>,
  })
  const slow = createRoute({ getParentRoute: () => project, path: "/site", ...projectPagePending, component: pages.slow })
  const quick = createRoute({ getParentRoute: () => project, path: "/settings", ...projectPagePending, component: pages.quick })
  const router = createRouter({
    routeTree: root.addChildren([project.addChildren([overview, slow, quick])]),
    history: createMemoryHistory({ initialEntries: ["/dashboard/projects/p1/project"] }),
  })
  render(<RouterProvider router={router} />)
  return router
}

const shell = () => screen.getByTestId("shell").textContent

describe("project page loading", () => {
  test("a slow page shows the loading view and the new sidebar view together", async () => {
    const page = slowPage("Site settings")
    const router = renderProject({ slow: page.component, quick: () => null })
    await screen.findByText("Overview")

    act(() => router.history.push("/dashboard/projects/p1/site"))
    // Before the wait ends, the old page and the old sidebar view stay.
    expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy()
    expect(shell()).toBe("/dashboard/projects/p1/project ready")

    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Loading page")
    expect(shell()).toBe("/dashboard/projects/p1/site loading")
    // React keeps the old page mounted but hidden until the new one shows.
    expect(screen.queryByRole("heading", { name: "Overview" })).toBeNull()

    await page.finish()
    await screen.findByRole("heading", { name: "Site settings" }, { timeout: 2_000 })
    expect(screen.queryByRole("status")).toBeNull()
    expect(shell()).toBe("/dashboard/projects/p1/site ready")
  })

  test("a page that loads within the wait never shows the loading view", async () => {
    const page = slowPage("Settings")
    const router = renderProject({ slow: () => null, quick: page.component })
    await screen.findByText("Overview")

    act(() => router.history.push("/dashboard/projects/p1/settings"))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    await page.finish()

    await screen.findByText("Settings")
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)))
    expect(screen.queryByRole("status")).toBeNull()
    expect(shell()).toBe("/dashboard/projects/p1/settings ready")
  })

  test("the loading view stays long enough not to flash", async () => {
    const page = slowPage("Site settings")
    const router = renderProject({ slow: page.component, quick: () => null })
    await screen.findByText("Overview")

    act(() => router.history.push("/dashboard/projects/p1/site"))
    await screen.findByRole("status")
    const shownAt = performance.now()
    await page.finish()

    await waitFor(() => expect(screen.getByRole("heading", { name: "Site settings" })).toBeTruthy(), { timeout: 2_000 })
    expect(performance.now() - shownAt).toBeGreaterThanOrEqual(projectPagePending.pendingMinMs - 20)
  })
})

describe("project top bar crumbs", () => {
  const base = "/dashboard/projects/p1"

  test("pages with their own top bar get a plain one only while they load", () => {
    expect(projectCrumbs(`${base}/content`, "p1", false)).toBeNull()
    expect(projectCrumbs(`${base}/content`, "p1", true)).toEqual(["Content"])
    expect(projectCrumbs(`${base}/site/navigation`, "p1", false)).toBeNull()
    expect(projectCrumbs(`${base}/site/navigation`, "p1", true)).toEqual(["Site settings", "Navigation"])
  })

  test("the simple pages keep their crumbs", () => {
    expect(projectCrumbs(`${base}/project`, "p1", true)).toEqual(["Overview"])
    expect(projectCrumbs(`${base}/generations`, "p1", false)).toEqual(["Generations"])
    expect(projectCrumbs(`${base}/settings`, "p1", true)).toEqual(["Settings"])
    expect(projectCrumbs(`${base}/settings/approvals`, "p1", false)).toEqual(["Settings", "Agent approvals"])
    expect(projectCrumbs(`${base}/requests`, "p1", false)).toEqual(["Requests"])
    expect(projectCrumbs(`${base}/requests/r1`, "p1", true)).toEqual(["Requests"])
    expect(projectCrumbs(`${base}/generations/0123456789ab`, "p1", false)).toHaveLength(2)
    expect(projectCrumbs(`${base}/generations/0123456789ab/changes`, "p1", false)).toEqual([
      "Generations",
      expect.any(String),
      "Changes",
    ])
  })
})
