import { createFileRoute } from "@tanstack/react-router"

import { DoxabotInstructionsPage } from "~/components/dashboard/doxabot/instructions/instructions-page"
import { dashboardPendingView } from "~/components/dashboard/pending-view"
import { projectPagePending } from "~/components/dashboard/route-pending"

export const Route = createFileRoute("/dashboard/projects/$projectId/doxabot/instructions")({
  ...projectPagePending,
  pendingComponent: dashboardPendingView("doxabotInstructions"),
  component: DoxabotInstructionsRoute,
})

function DoxabotInstructionsRoute() {
  const { projectId } = Route.useParams()
  return <DoxabotInstructionsPage projectId={projectId} />
}
