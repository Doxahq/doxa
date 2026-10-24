import { useState, type ReactNode } from "react"
import { Check, Loader2, X } from "lucide-react"
import type { DashboardApprovalRequest } from "@doxahq/contracts/approval-requests"

import { ProgressSteps, type ProgressStepItem } from "~/components/dashboard/content/branches/progress-steps"
import { Button } from "~/components/ui/button"
import { Checkbox } from "~/components/ui/checkbox"
import { Input } from "~/components/ui/input"
import { approveBlockedMessage, closedRequestMessage } from "~/lib/dashboard/approval-request-model"
import { useApprovalDecision } from "~/lib/dashboard/use-approval-decision"
import { useEraseBranchDefault } from "~/lib/dashboard/use-approval-settings"
import { PUBLISH_STEPS } from "~/lib/dashboard/use-publish-branch"
import { cn } from "~/lib/utils"

const STAGE_LABELS = { preparing: "Preparing", building: "Building", optimizing: "Optimizing", live: "Live" } as const

/**
 * The approve and reject controls of one request, shared by the approval
 * page and the publish menu. Destructive actions need the typed name. A
 * publish offers to erase the agent's branch; the project setting
 * "Erase the branch after an approved publish" picks the default.
 *
 * The server's `viewer` says whether this member may approve and reject.
 * When approve is refused (the second-person rule, or a role without the
 * capability), Approve stays visible but disabled with the reason. Reject
 * shows only when the role may reject (`approvals.decide`).
 *
 * The fields and the buttons render in two parts, so a panel can put the
 * buttons in its footer. `footerStart` goes at the start of the button row.
 */
export function ApprovalDecision({
  request,
  approveLabel = "Approve",
  onApproved,
  footerStart,
  className,
  bodyClassName,
  footerClassName,
}: {
  request: DashboardApprovalRequest
  approveLabel?: string
  onApproved?: (detail: DashboardApprovalRequest) => void
  footerStart?: ReactNode
  className?: string
  bodyClassName?: string
  footerClassName?: string
}) {
  const projectId = request.projectId ?? ""
  const decision = useApprovalDecision(projectId, request.id, { onApproved })
  const [reason, setReason] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const [isRejecting, setIsRejecting] = useState(false)
  const isPublish = request.actionKind === "docs.publish"
  const eraseDefault = useEraseBranchDefault(projectId, isPublish && projectId !== "" && request.viewer.canApprove)
  const [erasePick, setErasePick] = useState<boolean | null>(null)
  const eraseBranch = erasePick ?? eraseDefault ?? true
  const current = decision.decided ?? request
  const closed = closedRequestMessage(current.status)

  const layout = (body: ReactNode, buttons: ReactNode) => (
    <div className={cn("flex flex-col gap-3", className)}>
      {body ? <div className={cn("flex flex-col gap-3", bodyClassName)}>{body}</div> : null}
      {buttons || footerStart ? (
        <div className={cn("flex flex-wrap items-center gap-2", footerClassName)}>
          {footerStart}
          <div className="ml-auto flex flex-wrap items-center gap-2">{buttons}</div>
        </div>
      ) : null}
    </div>
  )

  if (closed) return layout(<DecisionOutcome request={current} message={closed} />, null)
  if (decision.isApproving && request.reviewSurface.kind === "publish_menu") {
    return layout(
      <ProgressSteps label="Publish progress" steps={publishSteps(decision.stage)} />,
      <Button type="button" size="sm" disabled>
        <Loader2 aria-hidden="true" className="animate-spin" />
        Publishing…
      </Button>,
    )
  }

  const approveBlocked = approveBlockedMessage(request.viewer)
  const showApproveFields = !isRejecting && approveBlocked === null
  const needsConfirmation = request.confirmationText !== null
  const confirmed = !needsConfirmation || confirmation.trim() === request.confirmationText
  const approve = () =>
    decision.approve({
      ...(needsConfirmation ? { confirmation: confirmation.trim() } : {}),
      ...(isPublish ? { eraseBranch } : {}),
    })
  const fields = [
    isPublish && showApproveFields ? (
      <label key="erase" className="flex cursor-pointer items-center gap-2.5 text-[13px] text-body">
        <Checkbox
          checked={eraseBranch}
          disabled={eraseDefault === undefined}
          onChange={(event) => setErasePick(event.target.checked)}
        />
        Erase this branch after publish
      </label>
    ) : null,
    needsConfirmation && showApproveFields ? (
      <label key="confirm" className="flex flex-col gap-1.5 text-[13px] text-body">
        Type <span className="font-mono text-foreground">{request.confirmationText}</span> to approve.
        <Input id={`confirm-${request.id}`} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
      </label>
    ) : null,
    isRejecting ? (
      <label key="reason" className="flex flex-col gap-1.5 text-[13px] text-body">
        Reason for the agent (optional)
        <Input id={`reason-${request.id}`} autoFocus value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
      </label>
    ) : null,
    approveBlocked && !isRejecting ? (
      <p key="blocked" className="text-[13px] text-muted-foreground">
        {approveBlocked}
      </p>
    ) : null,
    decision.error ? <p key="error" role="alert" className="text-[13px] text-danger">{decision.error}</p> : null,
  ].filter(Boolean)

  return layout(
    fields.length > 0 ? fields : null,
    <>
      {isRejecting ? (
        <Button type="button" variant="ghost" size="sm" disabled={decision.isDeciding} onClick={() => setIsRejecting(false)}>
          Cancel
        </Button>
      ) : null}
      {request.viewer.canReject ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={decision.isDeciding}
          onClick={() => (isRejecting ? decision.reject(reason) : setIsRejecting(true))}
        >
          <X aria-hidden="true" />
          {isRejecting ? "Send rejection" : "Reject"}
        </Button>
      ) : null}
      {isRejecting ? null : (
        <Button
          type="button"
          size="sm"
          // A publish waits for the erase default, so a fast click never sends the wrong one.
          disabled={
            approveBlocked !== null || decision.isDeciding || !confirmed || (isPublish && eraseDefault === undefined)
          }
          onClick={approve}
        >
          {decision.isApproving ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Check aria-hidden="true" />}
          {approveLabel}
        </Button>
      )}
    </>,
  )
}

function DecisionOutcome({ request, message }: { request: DashboardApprovalRequest; message: string }) {
  const failed = request.status === "failed" || request.status === "stale"
  return (
    <div className="flex flex-col gap-1 text-[13px]">
      <p className={failed ? "text-warning" : "text-muted-foreground"}>{message}</p>
      {request.error ? <p className="text-muted-foreground">{request.error.message}</p> : null}
      {request.decisionNote ? <p className="text-muted-foreground">Reason: {request.decisionNote}</p> : null}
    </div>
  )
}

function publishSteps(stage: string | null): ProgressStepItem[] {
  const index = stage === null ? 0 : PUBLISH_STEPS.findIndex((step) => step === stage)
  return PUBLISH_STEPS.map((step, position) => ({
    label: STAGE_LABELS[step],
    detail: "",
    state: position < index ? "done" : position === index ? "current" : "pending",
  }))
}
