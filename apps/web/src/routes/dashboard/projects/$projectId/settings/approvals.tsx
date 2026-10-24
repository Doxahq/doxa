import { createFileRoute } from "@tanstack/react-router"

import { ProjectApprovalsPage } from "~/components/dashboard/project-approvals-page"
import { dashboardPendingView } from "~/components/dashboard/pending-view"
import { projectPagePending } from "~/components/dashboard/route-pending"

export const Route = createFileRoute("/dashboard/projects/$projectId/settings/approvals")({
  ...projectPagePending,
  pendingComponent: dashboardPendingView("projectApprovals"),
  component: ProjectApprovalsRoute,
})

function ProjectApprovalsRoute() {
  const { projectId } = Route.useParams()
  return <ProjectApprovalsPage projectId={projectId} />
}
