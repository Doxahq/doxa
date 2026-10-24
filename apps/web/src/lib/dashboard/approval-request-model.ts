import type {
  ApprovalRequestDetail,
  ApprovalRequestStatus,
  ApprovalRequestViewer,
  ApproveBlockReason,
} from "@doxahq/contracts/approval-requests"
import { ApiRequestError } from "~/lib/api-errors"

export type ApprovalTone = "warning" | "success" | "muted" | "destructive" | "outline"

const STATUS_VIEW: Record<ApprovalRequestStatus, { label: string; tone: ApprovalTone }> = {
  pending: { label: "Pending", tone: "warning" },
  executing: { label: "Running", tone: "outline" },
  completed: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "destructive" },
  rejected: { label: "Rejected", tone: "muted" },
  cancelled: { label: "Cancelled", tone: "muted" },
  expired: { label: "Expired", tone: "muted" },
  stale: { label: "Out of date", tone: "muted" },
}

export function approvalStatusView(status: ApprovalRequestStatus) {
  return STATUS_VIEW[status]
}

/** Why a request that is not pending can no longer be decided, for the reviewer. */
export function closedRequestMessage(status: ApprovalRequestStatus): string | null {
  switch (status) {
    case "pending":
      return null
    case "stale":
      return "The changes moved after the request. The agent must ask again."
    case "expired":
      return "Nobody decided this request in time. The agent must ask again."
    case "cancelled":
      return "The request was withdrawn."
    case "executing":
      return "This request is running."
    default:
      return "This request is already decided."
  }
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

/** "2 minutes ago", "3 days ago". */
export function formatRequestAge(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000)
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ]
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return RELATIVE.format(Math.round(seconds / size), unit)
  }
  return RELATIVE.format(seconds, "second")
}

/** True when a completed publish request also deleted its branch. */
export function erasedBranchOnApprove(request: ApprovalRequestDetail): boolean {
  if (request.actionKind !== "docs.publish" || request.status !== "completed") return false
  const result = request.result
  return typeof result === "object" && result !== null && "branchErased" in result && result.branchErased === true
}

/**
 * Who asked: "Jane Doe via Claude Code" in a team, so members see whose
 * agent it was; the agent name alone when the member name is unknown.
 */
export function requesterLabel(requestedBy: { name: string | null; clientName: string }): string {
  return requestedBy.name ? `${requestedBy.name} via ${requestedBy.clientName}` : requestedBy.clientName
}

const OTHER_DECIDER_MESSAGE = "Your own agent asked, so another member must approve this request. You can still reject it."

const APPROVE_BLOCK_MESSAGES: Record<ApproveBlockReason, string> = {
  other_decider_required: OTHER_DECIDER_MESSAGE,
  missing_capability: "Your role cannot approve this request.",
}

const CANNOT_DECIDE_MESSAGE = "Your role cannot approve or reject this request."

/** Why this viewer cannot approve, from the server's `viewer`; null when they can. */
export function approveBlockedMessage(viewer: ApprovalRequestViewer): string | null {
  if (viewer.canApprove) return null
  return viewer.canReject ? APPROVE_BLOCK_MESSAGES[viewer.reason] : CANNOT_DECIDE_MESSAGE
}

/** The message for a failed decision; the second-person rule gets a clear one. */
export function decisionErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError && error.code === "other_decider_required") return OTHER_DECIDER_MESSAGE
  return error instanceof Error ? error.message : fallback
}
