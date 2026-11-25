import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { useRouterState } from "@tanstack/react-router"

import { useDashboardAuth } from "~/lib/auth/dashboard-auth-context"

/**
 * The first load of the dashboard through `/dashboard`.
 *
 * `/dashboard` has no page of its own: it waits for the project list, then
 * opens the last project (or the new project page). The user must see one
 * loading state shaped like the page that comes, and then that page, with
 * nothing in between:
 *
 * - The main area draws the Overview's top bar and skeleton from the first
 *   frame. The landing, the route's pending view and the Overview's first load
 *   all draw that same skeleton, so the redirect changes nothing on screen.
 * - The sidebar draws `ProjectSidebarSkeleton` while `booting` is true, even
 *   after the project is known. So the real sidebar and the real page replace
 *   their skeletons in the same frame: the page reports its first load in a
 *   layout effect (`useDashboardPageReady`), and the sidebar re-renders before
 *   the browser paints.
 *
 * `booting` ends when the page reports its first load and the identity is
 * known. It also ends after `BOOT_TIMEOUT_MS` while the router is idle, so a
 * page that never reports cannot keep the sidebar skeleton forever. The time
 * counts only while no route code or loader is pending: a slow download of the
 * page code never ends it early.
 *
 * Only a full page load of `/dashboard` starts it. A later navigation inside
 * the dashboard keeps the real sidebar and the page skeletons.
 */

const BOOT_TIMEOUT_MS = 12_000

interface DashboardBoot {
  /** True while the dashboard opens its first page from `/dashboard`. */
  booting: boolean
  /** Called by the page that the landing opens when its first load is done. */
  reportPageReady: () => void
}

const DashboardBootContext = createContext<DashboardBoot>({ booting: false, reportPageReady: () => {} })

export function DashboardBootProvider({ active, children }: { active: boolean; children: ReactNode }) {
  const { isPending: identityPending } = useDashboardAuth()
  const routerIdle = useRouterState({ select: (state) => state.status === "idle" })
  const [started] = useState(active)
  const [pageReady, setPageReady] = useState(false)
  const [timedOut, setTimedOut] = useState(false)
  const reportPageReady = useCallback(() => setPageReady(true), [])
  // Derived during render, so the frame that commits the ready page also
  // commits the real sidebar.
  const booting = started && !timedOut && !(pageReady && !identityPending)

  useEffect(() => {
    if (!booting || !routerIdle) return
    const timer = window.setTimeout(() => setTimedOut(true), BOOT_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [booting, routerIdle])

  const value = useMemo(() => ({ booting, reportPageReady }), [booting, reportPageReady])

  return <DashboardBootContext.Provider value={value}>{children}</DashboardBootContext.Provider>
}

export function useDashboardBoot(): DashboardBoot {
  return useContext(DashboardBootContext)
}

/**
 * Tells the dashboard that the page has its first content. A page calls it on
 * every render, before any early return, with its own first-load flag.
 *
 * A layout effect: its state update renders again before the browser paints,
 * so the sidebar leaves its skeleton in the frame where the page leaves its own.
 */
export function useDashboardPageReady(ready: boolean): void {
  const { booting, reportPageReady } = useDashboardBoot()
  useLayoutEffect(() => {
    if (booting && ready) reportPageReady()
  }, [booting, ready, reportPageReady])
}
