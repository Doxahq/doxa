import { createFileRoute } from "@tanstack/react-router"

import { TeamsPage } from "~/components/dashboard/teams/teams-page"
import { dashboardPendingView } from "~/components/dashboard/pending-view"
import { projectPagePending } from "~/components/dashboard/route-pending"

export const Route = createFileRoute("/dashboard/teams/")({
  // The page skeleton, not a spinner: one loading state per visit.
  ...projectPagePending,
  pendingComponent: dashboardPendingView("teams"),
  component: TeamsPage,
})
