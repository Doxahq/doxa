import { createFileRoute } from "@tanstack/react-router"

import { DoxabotInstructionsPage } from "~/components/dashboard/doxabot/instructions/instructions-page"
import { dashboardPendingView } from "~/components/dashboard/pending-view"
import { projectPagePending } from "~/components/dashboard/route-pending"
import { parseInstructionsSearch } from "~/lib/dashboard/instructions-search"

export const Route = createFileRoute("/dashboard/projects/$projectId/doxabot/instructions")({
  ...projectPagePending,
  validateSearch: parseInstructionsSearch,
  pendingComponent: dashboardPendingView("doxabotInstructions"),
  component: DoxabotInstructionsRoute,
})

function DoxabotInstructionsRoute() {
  const { projectId } = Route.useParams()
  const { then } = Route.useSearch()
  return <DoxabotInstructionsPage projectId={projectId} startsGeneration={then === "generate"} />
}
