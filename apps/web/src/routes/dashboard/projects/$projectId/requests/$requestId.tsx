import { createFileRoute } from "@tanstack/react-router"

import { ApprovalRequestPage } from "~/components/dashboard/requests/approval-request-page"
import { dashboardPendingView } from "~/components/dashboard/pending-view"
import { projectPagePending } from "~/components/dashboard/route-pending"

export const Route = createFileRoute("/dashboard/projects/$projectId/requests/$requestId")({
  ...projectPagePending,
  pendingComponent: dashboardPendingView("approvalRequest"),
  component: ApprovalRequestRoute,
})

function ApprovalRequestRoute() {
  const { projectId, requestId } = Route.useParams()
  return <ApprovalRequestPage projectId={projectId} requestId={requestId} />
}
