import { createFileRoute } from "@tanstack/react-router"

import { dashboardPendingView } from "~/components/dashboard/pending-view"
import { projectPagePending } from "~/components/dashboard/route-pending"
import { SiteSettingsLayout } from "~/components/dashboard/site-settings/site-settings-layout"

export const Route = createFileRoute("/dashboard/projects/$projectId/site")({
  ...projectPagePending,
  pendingComponent: dashboardPendingView("siteSettings"),
  component: SiteSettingsRoute,
})

function SiteSettingsRoute() {
  const { projectId } = Route.useParams()
  return <SiteSettingsLayout projectId={projectId} />
}
