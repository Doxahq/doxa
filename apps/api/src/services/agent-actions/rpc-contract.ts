import { z } from "zod";
import { projectScopeClaimSchema } from "@doxahq/contracts/agent-access";
import {
  agentActionKindSchema,
  approvalRequestStatusSchema,
  MAX_APPROVAL_TEXT_LENGTH,
  type ApprovalRequestDetail,
  type ApprovalRequestError,
  type ApprovalRequestSummary,
  type PendingApprovalRequest,
} from "@doxahq/contracts/approval-requests";

/**
 * The service-binding contract between doxa-mcp and `AgentActionsApi`.
 * RPC drops error classes, so every method answers with `AgentActionsRpcResult`
 * instead of throwing. Pure module: doxa-mcp imports it without the runtime.
 */
export const agentActorClaimsSchema = z
  .object({
    userId: z.string().min(1),
    clientId: z.string().min(1),
    clientName: z.string().min(1).max(200),
    grantRef: z.uuid(),
    scopes: z.array(z.string()).max(32),
    projectScope: projectScopeClaimSchema,
  })
  .strict();

export const performActionRpcInputSchema = z
  .object({
    actor: agentActorClaimsSchema,
    action: agentActionKindSchema,
    projectId: z.uuid().nullable(),
    payload: z.unknown(),
    summary: z.string().trim().max(MAX_APPROVAL_TEXT_LENGTH).nullable(),
  })
  .strict();

export const requestRpcInputSchema = z
  .object({ actor: agentActorClaimsSchema, requestId: z.string().min(1).max(64) })
  .strict();

export const listRequestsRpcInputSchema = z
  .object({ actor: agentActorClaimsSchema, status: approvalRequestStatusSchema.optional() })
  .strict();

export type PerformActionRpcInput = z.input<typeof performActionRpcInputSchema>;
export type RequestRpcInput = z.input<typeof requestRpcInputSchema>;
export type ListRequestsRpcInput = z.input<typeof listRequestsRpcInputSchema>;

export type PerformActionRpcOutput =
  | { readonly outcome: "completed"; readonly result: unknown; readonly policySource: string }
  | {
      readonly outcome: "approval_required";
      readonly request: ApprovalRequestSummary;
      readonly pending: PendingApprovalRequest;
      readonly message: string;
      readonly policySource: string;
    };

/** What doxa-mcp shows as an MCP task: the request and the link a person approves it at. */
export interface ApprovalRequestTaskSource {
  readonly request: ApprovalRequestDetail;
  readonly approvalUrl: string;
}

export type AgentActionsRpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApprovalRequestError };

export interface AgentActionsRpc {
  perform(input: PerformActionRpcInput): Promise<AgentActionsRpcResult<PerformActionRpcOutput>>;
  getRequest(input: RequestRpcInput): Promise<AgentActionsRpcResult<ApprovalRequestDetail>>;
  /** `getRequest` plus the approval link, for MCP Tasks (spec v2 §9). */
  getRequestTask(input: RequestRpcInput): Promise<AgentActionsRpcResult<ApprovalRequestTaskSource>>;
  listRequests(input: ListRequestsRpcInput): Promise<AgentActionsRpcResult<ApprovalRequestSummary[]>>;
  cancelRequest(input: RequestRpcInput): Promise<AgentActionsRpcResult<ApprovalRequestDetail>>;
}
