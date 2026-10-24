import type { DashboardPendingViews } from "~/components/dashboard/skeletons/pending-views"
import { ProjectPagePending } from "~/components/dashboard/route-pending"

export type DashboardPendingViewId = keyof DashboardPendingViews

let registeredViews: DashboardPendingViews | null = null

/**
 * Called once by the dashboard layout module. Every dashboard route renders
 * inside that layout, so its code has run before any route's pending view can
 * show: the views are always there, with no download and no suspense.
 */
export function registerDashboardPendingViews(views: DashboardPendingViews): void {
  registeredViews = views
}

/**
 * The `pendingComponent` of a dashboard route: the page's own skeleton.
 *
 * The router keeps pending components in the main bundle, which the marketing
 * pages share. A route file therefore names its skeleton here instead of
 * importing it, and the skeleton code loads with the dashboard layout.
 */
export function dashboardPendingView(id: DashboardPendingViewId) {
  function DashboardPendingView() {
    const View = registeredViews?.[id]
    // Never expected: the dashboard layout registers the views before any
    // dashboard route renders. The shared loading label is a safe fallback.
    if (!View) return <ProjectPagePending />
    return <View />
  }
  DashboardPendingView.displayName = `DashboardPendingView(${id})`
  return DashboardPendingView
}
