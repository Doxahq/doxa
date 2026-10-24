import { createFileRoute } from "@tanstack/react-router"

import { TeamPage } from "~/components/dashboard/teams/team-page"
import { dashboardPendingView } from "~/components/dashboard/pending-view"
import { projectPagePending } from "~/components/dashboard/route-pending"

export const Route = createFileRoute("/dashboard/teams/$teamId")({
  // The page skeleton, not a spinner: one loading state per visit.
  ...projectPagePending,
  pendingComponent: dashboardPendingView("team"),
  component: TeamRoute,
})

function TeamRoute() {
  const { teamId } = Route.useParams()
  return <TeamPage teamId={teamId} />
}
