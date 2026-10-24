import { createFileRoute } from "@tanstack/react-router"

import { dashboardPendingView } from "~/components/dashboard/pending-view"
import { projectPagePending } from "~/components/dashboard/route-pending"
import { AdvancedSettingsPage } from "~/components/dashboard/site-settings/site-settings-sections"

export const Route = createFileRoute("/dashboard/projects/$projectId/site/advanced")({
  ...projectPagePending,
  pendingComponent: dashboardPendingView("siteSettingsSection"),
  component: AdvancedSettingsPage,
})
