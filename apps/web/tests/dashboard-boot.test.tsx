// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, test, vi } from "vitest"

const auth = vi.hoisted(() => ({ isPending: false }))
vi.mock("~/lib/auth/dashboard-auth-context", () => ({ useDashboardAuth: () => auth }))
const router = vi.hoisted(() => ({ status: "idle" as "idle" | "pending" }))
vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (state: { status: string }) => unknown }) => select(router),
}))

import { DashboardBootProvider, useDashboardBoot, useDashboardPageReady } from "~/lib/dashboard/dashboard-boot"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  auth.isPending = false
  router.status = "idle"
})

/** The page under test: it reports its first load. */
function Page({ ready }: { ready: boolean }) {
  useDashboardPageReady(ready)
  return <p>{ready ? "page" : "page skeleton"}</p>
}

/** Stands for the sidebar: it reads `booting`. */
function Sidebar() {
  const { booting } = useDashboardBoot()
  return <p>{booting ? "sidebar skeleton" : "sidebar"}</p>
}

function shell(ready: boolean, active = true) {
  return (
    <DashboardBootProvider active={active}>
      <Sidebar />
      <Page ready={ready} />
    </DashboardBootProvider>
  )
}

const sidebarSkeleton = () => screen.queryByText("sidebar skeleton")

describe("dashboard first load", () => {
  test("the server HTML of a /dashboard entry has the sidebar skeleton", () => {
    expect(renderToStaticMarkup(shell(false))).toContain("sidebar skeleton")
  })

  test("other entries never show it", () => {
    render(shell(false, false))
    expect(sidebarSkeleton()).toBeNull()
  })

  // The page reports in a layout effect and `booting` is derived in render, so
  // the real sidebar commits before the browser paints the ready page.
  test("the sidebar leaves its skeleton in the commit where the page is ready", () => {
    const frames: string[] = []
    function Probe() {
      const { booting } = useDashboardBoot()
      frames.push(booting ? "skeleton" : "real")
      return null
    }
    const view = render(
      <DashboardBootProvider active>
        <Probe />
        <Page ready={false} />
      </DashboardBootProvider>,
    )
    view.rerender(
      <DashboardBootProvider active>
        <Probe />
        <Page ready />
      </DashboardBootProvider>,
    )
    expect(screen.getByText("page")).toBeTruthy()
    expect(frames.at(-1)).toBe("real")
  })

  test("waits for the identity too", () => {
    auth.isPending = true
    const view = render(shell(true))
    expect(sidebarSkeleton()).toBeTruthy()
    auth.isPending = false
    view.rerender(shell(true))
    expect(sidebarSkeleton()).toBeNull()
  })

  test("the time limit does not count while route code loads", () => {
    vi.useFakeTimers()
    router.status = "pending"
    const view = render(shell(false))
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(sidebarSkeleton()).toBeTruthy()
    router.status = "idle"
    view.rerender(shell(false))
    act(() => {
      vi.advanceTimersByTime(11_000)
    })
    expect(sidebarSkeleton()).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(sidebarSkeleton()).toBeNull()
  })
})
