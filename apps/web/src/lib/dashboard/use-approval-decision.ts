import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { DashboardApprovalRequest, ApproveApprovalRequestInput } from "@doxahq/contracts/approval-requests"
import type { DocsPublishStage } from "@doxahq/contracts/docs-branches"

import { approveApprovalRequest, rejectApprovalRequest } from "~/lib/approval-requests-api"
import { decisionErrorMessage } from "~/lib/dashboard/approval-request-model"
import { approvalRequestQueryKeys } from "~/lib/queries/approval-requests"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"
import { docsBranchQueryKeys } from "~/lib/queries/docs-branches"

/** Approve or reject one request, then reload everything the action can change. */
export function useApprovalDecision(
  projectId: string,
  requestId: string,
  options: { onApproved?: (detail: DashboardApprovalRequest) => void } = {},
) {
  const queryClient = useQueryClient()
  const [stage, setStage] = useState<DocsPublishStage | null>(null)

  const refresh = async (detail: DashboardApprovalRequest) => {
    queryClient.setQueryData(approvalRequestQueryKeys.detail(projectId, requestId), detail)
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: approvalRequestQueryKeys.project(projectId) }),
      queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.contentRoot(projectId) }),
      queryClient.invalidateQueries({ queryKey: docsBranchQueryKeys.project(projectId) }),
      queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.project(projectId) }),
    ])
  }

  const approve = useMutation({
    mutationFn: (input: ApproveApprovalRequestInput) =>
      approveApprovalRequest(projectId, requestId, input, setStage),
    onSuccess: async (detail) => {
      await refresh(detail)
      options.onApproved?.(detail)
    },
  })
  const reject = useMutation({
    mutationFn: (reason: string) => rejectApprovalRequest(projectId, requestId, reason),
    onSuccess: refresh,
  })

  const failure = approve.error ?? reject.error
  return {
    approve: (input: ApproveApprovalRequestInput = {}) => {
      setStage(null)
      approve.mutate(input)
    },
    reject: (reason: string) => reject.mutate(reason),
    stage,
    isDeciding: approve.isPending || reject.isPending,
    isApproving: approve.isPending,
    decided: approve.data ?? reject.data ?? null,
    error: failure ? decisionErrorMessage(failure, "The decision could not be saved.") : null,
  }
}
