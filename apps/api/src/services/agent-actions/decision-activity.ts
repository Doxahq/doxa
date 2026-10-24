import type {
  AgentActivityOutcome,
  AgentActivityRecord,
} from "../../repositories/agent-activity";
import type { ApprovalRequestRecord } from "../../repositories/agent-approval-requests";

export type DecisionTool = "approve_request" | "reject_request";

/** Pure: the activity row for a human decision on an approval request. */
export function decisionActivity(input: {
  request: ApprovalRequestRecord;
  tool: DecisionTool;
  durationMs: number;
  /** False when the action removed the row (a deleted project cascades). */
  persisted: boolean;
}): AgentActivityRecord {
  const { request } = input;
  return {
    userId: request.requestedByUserId,
    clientId: request.requestedByClientId,
    clientName: request.requestedByClientName,
    grantRef: request.grantRef,
    projectId: input.persisted ? request.projectId : null,
    tool: input.tool,
    actionKind: request.actionKind,
    approvalRequestId: input.persisted ? request.id : null,
    outcome: decisionOutcome(request),
    errorCode: request.status === "rejected" ? null : (request.error?.code ?? null),
    policySource: request.policySource,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    inputSha256: null,
  };
}

function decisionOutcome(request: ApprovalRequestRecord): AgentActivityOutcome {
  switch (request.status) {
    case "completed":
      return "succeeded";
    case "rejected":
      return "denied";
    default:
      return "failed";
  }
}
