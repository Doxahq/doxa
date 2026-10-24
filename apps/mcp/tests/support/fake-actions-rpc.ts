import type { ApprovalRequestDetail } from "@doxahq/contracts/approval-requests";
import type {
  AgentActionsRpc,
  AgentActionsRpcResult,
  PerformActionRpcInput,
  PerformActionRpcOutput,
} from "@doxahq/api/services/agent-actions/rpc-contract";

export const PENDING_REQUEST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const APPROVAL_URL = `https://doxa.so/approve/${PENDING_REQUEST_ID}`;

/** What a fake doxa-api answers for each perform call, keyed by action. */
export type FakeOutcomes = Partial<Record<string, AgentActionsRpcResult<PerformActionRpcOutput>>>;

export function pendingOutcome(headline: string): AgentActionsRpcResult<PerformActionRpcOutput> {
  const pending = {
    id: PENDING_REQUEST_ID,
    status: "pending" as const,
    approvalUrl: APPROVAL_URL,
    expiresAt: "2026-10-11T12:00:00.000Z",
    pollAfterMs: 10_000,
  };
  return {
    ok: true,
    value: {
      outcome: "approval_required",
      request: detail("pending"),
      pending,
      message: `Ask the user to approve "${headline}" at ${pending.approvalUrl}.`,
      policySource: "action_default",
    },
  };
}

export function detail(status: ApprovalRequestDetail["status"]): ApprovalRequestDetail {
  return {
    id: PENDING_REQUEST_ID,
    projectId: "11111111-1111-4111-8111-111111111111",
    actionKind: "docs.publish",
    actionAvailable: true,
    status,
    title: "Publish a branch",
    headline: "Publish 2 changes from agent-docs",
    effects: ["The live site changes."],
    summary: null,
    requestedBy: { userId: "owner-user", name: null, clientName: "Test Agent" },
    decidedBy: null,
    decisionNote: null,
    policySource: "action_default",
    reviewSurface: { kind: "publish_menu" },
    branchId: null,
    confirmationText: null,
    error: null,
    createdAt: "2026-10-04T12:00:00.000Z",
    expiresAt: "2026-10-11T12:00:00.000Z",
    decidedAt: null,
    completedAt: null,
    inputs: {},
    result: null,
  };
}

/**
 * The one stored request of the fake doxa-api. A test replaces `detail` to
 * play a decision in the dashboard.
 */
export interface FakeApprovalRow {
  detail: ApprovalRequestDetail;
}

export function fakeApprovalRow(): FakeApprovalRow {
  return { detail: detail("pending") };
}

const NOT_FOUND = {
  ok: false,
  error: { code: "request_not_found", message: "The approval request does not exist." },
} as const;

/** Records every call; answers pending unless a test sets an outcome. */
export function createFakeActionsRpc(
  outcomes: FakeOutcomes = {},
  calls: PerformActionRpcInput[] = [],
  row: FakeApprovalRow = fakeApprovalRow(),
) {
  const known = (requestId: string) => requestId === row.detail.id;
  const rpc: AgentActionsRpc = {
    async perform(input) {
      calls.push(input);
      return outcomes[input.action] ?? pendingOutcome(input.action);
    },
    getRequest: async ({ requestId }) => (known(requestId) ? { ok: true, value: row.detail } : NOT_FOUND),
    getRequestTask: async ({ requestId }) =>
      known(requestId) ? { ok: true, value: { request: row.detail, approvalUrl: APPROVAL_URL } } : NOT_FOUND,
    listRequests: async () => {
      const { inputs: _inputs, result: _result, ...summary } = row.detail;
      return { ok: true, value: [summary] };
    },
    cancelRequest: async ({ requestId }) => {
      if (!known(requestId)) return NOT_FOUND;
      if (row.detail.status !== "pending") {
        return { ok: false, error: { code: "request_not_pending", message: "The request is not pending." } };
      }
      row.detail = { ...row.detail, status: "cancelled" };
      return { ok: true, value: row.detail };
    },
  };
  return { rpc, calls };
}
