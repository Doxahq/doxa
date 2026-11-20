import { createFileRoute } from "@tanstack/react-router"

import { AgentApprovalsPage } from "~/components/dashboard/settings/agent-approvals-page"
import { dashboardPendingView } from "~/components/dashboard/pending-view"
import { projectPagePending } from "~/components/dashboard/route-pending"

export const Route = createFileRoute("/dashboard/settings/approvals")({
  // The page skeleton, not a spinner: one loading state per visit.
  ...projectPagePending,
  pendingComponent: dashboardPendingView("agentApprovals"),
  component: AgentApprovalsPage,
})
