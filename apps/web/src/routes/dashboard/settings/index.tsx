import { createFileRoute } from "@tanstack/react-router"

import { SettingsPage } from "~/components/dashboard/settings-page"
import { dashboardPendingView } from "~/components/dashboard/pending-view"
import { projectPagePending } from "~/components/dashboard/route-pending"

export const Route = createFileRoute("/dashboard/settings/")({
  // The page skeleton, not a spinner: one loading state per visit.
  ...projectPagePending,
  pendingComponent: dashboardPendingView("accountSettings"),
  component: SettingsPage,
})
