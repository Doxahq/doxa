import {
  APPROVAL_REQUEST_STATUSES,
  type ApprovalRequestStatus,
  type ApprovalRequestSummary,
} from "@doxahq/contracts/approval-requests"

import { approvalStatusView } from "~/lib/dashboard/approval-request-model"

export type RequestStatusFilter = ApprovalRequestStatus | "all"

/** "all", or one agent as `agent:<client name>`, so no client name can collide with "all". */
export type RequestAgentFilter = "all" | `agent:${string}`

export interface RequestFilterOption<TValue extends string> {
  value: TValue
  label: string
}

export const REQUEST_STATUS_FILTER_OPTIONS: readonly RequestFilterOption<RequestStatusFilter>[] = [
  { value: "all", label: "All statuses" },
  ...APPROVAL_REQUEST_STATUSES.map((status) => ({
    value: status,
    label: approvalStatusView(status).label,
  })),
]

/** The server filters by status. "all" sends no status. */
export function statusQueryParam(filter: RequestStatusFilter): ApprovalRequestStatus | undefined {
  return filter === "all" ? undefined : filter
}

export function agentFilterFor(clientName: string): RequestAgentFilter {
  return `agent:${clientName}`
}

/**
 * One option per agent in the loaded requests, by name. The selected agent
 * stays in the list when the current status shows none of its requests, so
 * the control never loses its value.
 */
export function requestAgentOptions(
  requests: readonly ApprovalRequestSummary[],
  selected: RequestAgentFilter,
): RequestFilterOption<RequestAgentFilter>[] {
  const names = new Set(requests.map((request) => request.requestedBy.clientName))
  if (selected !== "all") names.add(selected.slice("agent:".length))
  return [
    { value: "all", label: "All agents" },
    ...[...names]
      .sort((left, right) => left.localeCompare(right))
      .map((name) => ({ value: agentFilterFor(name), label: name })),
  ]
}

export function filterRequestsByAgent(
  requests: readonly ApprovalRequestSummary[],
  filter: RequestAgentFilter,
): ApprovalRequestSummary[] {
  if (filter === "all") return [...requests]
  return requests.filter((request) => agentFilterFor(request.requestedBy.clientName) === filter)
}
