import { createFileRoute } from "@tanstack/react-router"

import { dashboardPendingView } from "~/components/dashboard/pending-view"
import { projectPagePending } from "~/components/dashboard/route-pending"
import { DomainsSettingsPage } from "~/components/dashboard/site-settings/site-settings-sections"

export const Route = createFileRoute("/dashboard/projects/$projectId/site/domains")({
  ...projectPagePending,
  pendingComponent: dashboardPendingView("siteSettingsSection"),
  component: DomainsSettingsRoute,
})

function DomainsSettingsRoute() {
  const { projectId } = Route.useParams()
  return <DomainsSettingsPage projectId={projectId} />
}
