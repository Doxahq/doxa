import { queryOptions } from "@tanstack/react-query"
import type { ApprovalRequestStatus } from "@doxahq/contracts/approval-requests"

import { getApprovalRequest, getApprovalRequestLink, listApprovalRequests } from "~/lib/approval-requests-api"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"
import { fromProjectShell } from "~/lib/queries/project-shell"

export const approvalRequestQueryKeys = {
  project: (projectId: string) => [...dashboardQueryKeys.project(projectId), "approval-requests"] as const,
  list: (projectId: string, status: ApprovalRequestStatus | "all") =>
    [...approvalRequestQueryKeys.project(projectId), "list", status] as const,
  detail: (projectId: string, requestId: string) =>
    [...approvalRequestQueryKeys.project(projectId), "detail", requestId] as const,
  link: (requestId: string) => ["approval-request-links", requestId] as const,
}

/** Pending requests change when an agent asks, so the list refreshes often. */
export function approvalRequestListQueryOptions(projectId: string, status?: ApprovalRequestStatus) {
  return queryOptions({
    queryKey: approvalRequestQueryKeys.list(projectId, status ?? "all"),
    queryFn: (context) => {
      const fetchOwn = () => listApprovalRequests(projectId, status)
      // The shell holds the pending list only.
      return status === "pending" ? fromProjectShell(context, projectId, "pendingApprovalRequests", fetchOwn) : fetchOwn()
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
  })
}

export function approvalRequestQueryOptions(projectId: string, requestId: string) {
  return queryOptions({
    queryKey: approvalRequestQueryKeys.detail(projectId, requestId),
    queryFn: () => getApprovalRequest(projectId, requestId),
    staleTime: 5_000,
    retry: false,
  })
}

export function approvalRequestLinkQueryOptions(requestId: string) {
  return queryOptions({
    queryKey: approvalRequestQueryKeys.link(requestId),
    queryFn: () => getApprovalRequestLink(requestId),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
}
