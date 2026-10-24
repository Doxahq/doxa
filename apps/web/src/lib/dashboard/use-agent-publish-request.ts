import { useEffect, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { DashboardApprovalRequest } from "@doxahq/contracts/approval-requests"
import type { BranchRef } from "@doxahq/contracts/docs-branches"

import { approvalRequestListQueryOptions, approvalRequestQueryOptions } from "~/lib/queries/approval-requests"

/**
 * The agent publish request of the open branch. A link (`?request=<id>`)
 * selects its branch and opens the publish menu once, then leaves the URL:
 * a refresh does not open the menu again, and the user can switch branches.
 * The menu keeps the linked request, so it can show the decision. Without a
 * link, the newest pending publish request of the branch is shown.
 */
export function useAgentPublishRequest(options: {
  projectId: string
  linkedRequestId: string | null
  branchRef: BranchRef
  selectBranch: (branch: BranchRef) => void
  openApproval: () => void
  onLinkOpened?: () => void
}): DashboardApprovalRequest | null {
  const { projectId, linkedRequestId, branchRef, selectBranch, openApproval, onLinkOpened } = options
  const [opened, setOpened] = useState<{ id: string; branchId: string } | null>(null)
  const pending = useQuery({
    ...approvalRequestListQueryOptions(projectId, "pending"),
    enabled: branchRef !== "main",
  })
  const branchRequestId =
    pending.data?.requests.find(
      (request) => request.actionKind === "docs.publish" && request.branchId === branchRef,
    )?.id ?? null
  const openedId = opened?.branchId === branchRef ? opened.id : null
  const requestId = linkedRequestId ?? openedId ?? branchRequestId
  const detail = useQuery({
    ...approvalRequestQueryOptions(projectId, requestId ?? ""),
    enabled: requestId !== null,
  })
  const request = detail.data ?? null
  const handledLink = useRef<string | null>(null)
  const selectedFor = useRef<string | null>(null)

  useEffect(() => {
    if (!linkedRequestId || request?.id !== linkedRequestId) return
    if (handledLink.current === linkedRequestId) return
    // One try only: an erased branch cannot be selected, and the link must not loop.
    const onBranch = request.branchId === branchRef
    if (request.branchId && !onBranch && selectedFor.current !== linkedRequestId) {
      selectedFor.current = linkedRequestId
      selectBranch(request.branchId)
      return
    }
    handledLink.current = linkedRequestId
    if (request.branchId && onBranch) {
      setOpened({ id: request.id, branchId: request.branchId })
      openApproval()
    }
    onLinkOpened?.()
  }, [branchRef, linkedRequestId, onLinkOpened, openApproval, request, selectBranch])

  return request?.branchId === branchRef ? request : null
}
