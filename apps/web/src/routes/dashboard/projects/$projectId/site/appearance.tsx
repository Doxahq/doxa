import { createFileRoute } from "@tanstack/react-router"

import { dashboardPendingView } from "~/components/dashboard/pending-view"
import { projectPagePending } from "~/components/dashboard/route-pending"
import { AppearanceSettingsPage } from "~/components/dashboard/site-settings/site-settings-sections"

export const Route = createFileRoute("/dashboard/projects/$projectId/site/appearance")({
  ...projectPagePending,
  pendingComponent: dashboardPendingView("siteSettingsSection"),
  component: AppearanceSettingsPage,
})
