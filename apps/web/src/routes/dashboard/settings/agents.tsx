import { createFileRoute } from "@tanstack/react-router"

import { ConnectedAgentsPage } from "~/components/dashboard/settings/connected-agents-page"
import { dashboardPendingView } from "~/components/dashboard/pending-view"
import { projectPagePending } from "~/components/dashboard/route-pending"

export const Route = createFileRoute("/dashboard/settings/agents")({
  // The page skeleton, not a spinner: one loading state per visit.
  ...projectPagePending,
  pendingComponent: dashboardPendingView("connectedAgents"),
  component: ConnectedAgentsPage,
})
