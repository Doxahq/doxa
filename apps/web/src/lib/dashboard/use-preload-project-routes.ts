import { useEffect } from "react"
import { useRouter } from "@tanstack/react-router"

import { whenPageSettles } from "~/lib/when-page-settles"

/** The project pages that the sidebar links to. */
const PROJECT_PAGE_ROUTE_IDS: ReadonlySet<string> = new Set([
  "/dashboard/projects/$projectId/project",
  "/dashboard/projects/$projectId/content",
  "/dashboard/projects/$projectId/generations/",
  "/dashboard/projects/$projectId/doxabot/",
  "/dashboard/projects/$projectId/requests/",
  "/dashboard/projects/$projectId/settings/",
])

/** The site settings layout route. Its sections are its children. */
const SITE_SETTINGS_ROUTE_ID = "/dashboard/projects/$projectId/site"

/** True for a route whose code loads in the background (see `usePreloadProjectRoutes`). */
export function isPreloadedProjectRoute(routeId: string): boolean {
  return (
    PROJECT_PAGE_ROUTE_IDS.has(routeId)
    || routeId === SITE_SETTINGS_ROUTE_ID
    || routeId.startsWith(`${SITE_SETTINGS_ROUTE_ID}/`)
  )
}

/** The Write editor, the default mode of the content page. */
function loadWriteEditor() {
  return import("~/components/dashboard/content/write-editor/write-editor")
}

let started = false

/**
 * Loads the code of the main project pages (and the site settings sections)
 * in the background after a project page settles, so the first visit to each
 * one does not wait for it. It also starts the Write editor download, the
 * largest part of the content page. It loads code only: no loader runs and
 * nothing renders. It runs once per page load.
 */
export function usePreloadProjectRoutes(): void {
  const router = useRouter()

  useEffect(() => {
    if (started) return
    return whenPageSettles(() => {
      if (started) return
      started = true
      for (const route of Object.values(router.routesById)) {
        if (!isPreloadedProjectRoute(route.id)) continue
        // The router uses the same call when a link preloads on hover.
        void router.loadRouteChunk(route)
      }
      // A failed download shows later, when the content page asks for it.
      void loadWriteEditor().catch(() => undefined)
    })
  }, [router])
}
