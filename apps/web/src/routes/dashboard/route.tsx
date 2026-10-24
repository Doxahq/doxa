import { createFileRoute, redirect } from "@tanstack/react-router"

import { DashboardLayout } from "~/components/dashboard/dashboard-layout"
import { getDashboardEntry } from "~/server/dashboard-session"

const DASHBOARD_SESSION_CACHE_MS = 5 * 60 * 1000

export const Route = createFileRoute("/dashboard")({
  staleTime: DASHBOARD_SESSION_CACHE_MS,
  preloadStaleTime: DASHBOARD_SESSION_CACHE_MS,
  loader: async ({ location }) => {
    // Only the session cookie is checked here, so the HTML never waits for
    // the API. The browser loads the identity and handles a stale cookie.
    const dashboardEntry = await getDashboardEntry()

    if (!dashboardEntry) {
      throw redirect({
        to: "/login",
        search: {
          redirect: location.href,
        },
      })
    }

    return { dashboardEntry }
  },
  component: DashboardLayout,
})
