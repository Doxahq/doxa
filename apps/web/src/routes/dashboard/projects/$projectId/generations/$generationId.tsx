import { createFileRoute } from "@tanstack/react-router"

import { ProjectGenerationPage } from "~/components/dashboard/project-generation-page"
import { dashboardPendingView } from "~/components/dashboard/pending-view"
import { projectPagePending } from "~/components/dashboard/route-pending"

export const Route = createFileRoute("/dashboard/projects/$projectId/generations/$generationId")({
  ...projectPagePending,
  pendingComponent: dashboardPendingView("generation"),
  component: ProjectGenerationRoute,
})

function ProjectGenerationRoute() {
  const { projectId, generationId } = Route.useParams()
  return <ProjectGenerationPage projectId={projectId} generationId={generationId} />
}
