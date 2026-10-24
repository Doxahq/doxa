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
  useRouterState,
} from "@tanstack/react-router"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { useRenderedPathname } from "~/lib/dashboard/use-rendered-pathname"

// The router restores scroll after a navigation. jsdom has no scrolling.
beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Probe() {
  const url = useRouterState({ select: (state) => state.location.pathname })
  const rendered = useRenderedPathname()
  return <p data-testid="probe">{`url ${url}, rendered ${rendered}`}</p>
}

describe("useRenderedPathname", () => {
  test("keeps the page on screen until the next route's code loads", async () => {
    let finishLoading!: (module: { default: ComponentType }) => void
    const slowModule = new Promise<{ default: ComponentType }>((resolve) => {
      finishLoading = resolve
    })
    const root = createRootRoute({
      component: () => (
        <>
          <Probe />
          <Outlet />
        </>
      ),
    })
    const first = createRoute({ getParentRoute: () => root, path: "/first", component: () => <h1>First page</h1> })
    const second = createRoute({
      getParentRoute: () => root,
      path: "/second",
      component: lazyRouteComponent(() => slowModule),
    })
    const router = createRouter({
      routeTree: root.addChildren([first, second]),
      history: createMemoryHistory({ initialEntries: ["/first"] }),
    })
    render(<RouterProvider router={router} />)
    await screen.findByText("First page")
    const probe = () => screen.getByTestId("probe").textContent

    act(() => router.history.push("/second"))
    await waitFor(() => expect(probe()).toBe("url /second, rendered /first"))
    expect(screen.getByText("First page")).toBeTruthy()

    await act(async () => finishLoading({ default: () => <h1>Second page</h1> }))
    await screen.findByText("Second page")
    expect(probe()).toBe("url /second, rendered /second")
  })
})
