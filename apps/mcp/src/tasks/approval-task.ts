import {
  APPROVAL_POLL_AFTER_MS,
  type ApprovalRequestDetail,
} from "@doxahq/contracts/approval-requests";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ApprovalRequestTaskSource } from "@doxahq/api/services/agent-actions/rpc-contract";
import type { ToolErrorBody } from "../errors";
import { toolFailure, toolSuccess } from "../tool-result";

/** The one input request of a task; its key never changes (SEP-2663 key rule). */
export const APPROVAL_INPUT_KEY = "approval";

/** The `Task` fields of SEP-2663, shared by every status. */
type TaskFields = {
  readonly taskId: string;
  readonly statusMessage: string;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  /** Null: approval requests are never deleted. */
  readonly ttlMs: null;
  readonly pollIntervalMs: number;
};

/** A URL-mode elicitation: the client shows the approval link to its user. */
export type ApprovalLinkInput = {
  readonly method: "elicitation/create";
  readonly params: { readonly mode: "url"; readonly message: string; readonly url: string };
};

/**
 * What `tasks/get` returns. Doxa never uses `failed`: the extension keeps it
 * for JSON-RPC errors, and a refused action is a tool error inside a
 * `completed` result, as the tool would have returned it.
 */
export type ApprovalTask = TaskFields &
  (
    | { readonly status: "working" }
    | {
        readonly status: "input_required";
        readonly inputRequests: { readonly [APPROVAL_INPUT_KEY]: ApprovalLinkInput };
      }
    | { readonly status: "completed"; readonly result: CallToolResult }
    | { readonly status: "cancelled" }
  );

export type ApprovalTaskStatus = ApprovalTask["status"];

/**
 * Spec v2 §9: a gated action as an MCP task. The task ID is the approval
 * request ID, so the approval row is the durable task state. `mcpRequestId`
 * goes into tool errors, to match the log line of this MCP request.
 */
export function approvalTask(source: ApprovalRequestTaskSource, mcpRequestId: string): ApprovalTask {
  const { request } = source;
  const fields = taskFields(request);
  switch (request.status) {
    case "pending":
      return {
        ...fields,
        status: "input_required",
        statusMessage: `Waiting for a person to approve the request at ${source.approvalUrl}.`,
        inputRequests: { [APPROVAL_INPUT_KEY]: approvalLinkInput(source) },
      };
    case "executing":
      return { ...fields, status: "working", statusMessage: "The request was approved. The action is running." };
    case "completed":
      return {
        ...fields,
        status: "completed",
        statusMessage: "The action completed.",
        result: toolSuccess({ outcome: "completed", result: request.result }),
      };
    case "cancelled":
      return { ...fields, status: "cancelled", statusMessage: "The request was cancelled." };
    case "rejected":
    case "expired":
    case "stale":
    case "failed": {
      const error = refusalOf(request.status, request, mcpRequestId);
      return { ...fields, status: "completed", statusMessage: error.message, result: toolFailure(error) };
    }
  }
}

function taskFields(request: ApprovalRequestDetail): Omit<TaskFields, "statusMessage"> {
  return {
    taskId: request.id,
    createdAt: request.createdAt,
    lastUpdatedAt: request.completedAt ?? request.decidedAt ?? request.createdAt,
    ttlMs: null,
    pollIntervalMs: APPROVAL_POLL_AFTER_MS,
  };
}

/** Identical on every poll, so clients show it once. */
function approvalLinkInput(source: ApprovalRequestTaskSource): ApprovalLinkInput {
  return {
    method: "elicitation/create",
    params: {
      mode: "url",
      message: `Approve "${source.request.headline}" in Doxa.`,
      url: source.approvalUrl,
    },
  };
}

type RefusedStatus = Extract<ApprovalRequestDetail["status"], "rejected" | "expired" | "stale" | "failed">;

/** The tool error an agent reads when the action will not run. */
function refusalOf(status: RefusedStatus, request: ApprovalRequestDetail, mcpRequestId: string): ToolErrorBody {
  switch (status) {
    case "rejected":
      return {
        code: "request_rejected",
        message: request.decisionNote
          ? `The user rejected the request: ${request.decisionNote}`
          : "The user rejected the request.",
        requestId: mcpRequestId,
      };
    case "expired":
      return { code: "request_expired", message: "Nobody decided the request before it expired.", requestId: mcpRequestId };
    case "stale":
      return {
        code: "stale",
        message: request.error?.message ?? "The request went stale: its target changed after the agent asked.",
        requestId: mcpRequestId,
      };
    case "failed":
      return {
        code: "action_failed",
        message: request.error?.message ?? "The approved action failed.",
        requestId: mcpRequestId,
      };
  }
}

/** The `Task` alone, as a `CreateTaskResult` carries it. */
export type TaskSnapshot = TaskFields & { readonly status: ApprovalTaskStatus };

export function taskSnapshot(task: ApprovalTask): TaskSnapshot {
  return {
    taskId: task.taskId,
    status: task.status,
    statusMessage: task.statusMessage,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: task.ttlMs,
    pollIntervalMs: task.pollIntervalMs,
  };
}
