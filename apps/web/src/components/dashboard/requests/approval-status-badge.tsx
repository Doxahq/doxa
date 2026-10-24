import type { ApprovalRequestStatus } from "@doxahq/contracts/approval-requests"

import { Badge } from "~/components/ui/badge"
import { approvalStatusView } from "~/lib/dashboard/approval-request-model"

export function ApprovalStatusBadge({ status }: { status: ApprovalRequestStatus }) {
  const view = approvalStatusView(status)
  return <Badge variant={view.tone}>{view.label}</Badge>
}
