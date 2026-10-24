import type {
  AgentActionKind,
  ApprovalRequestDetail,
  ApprovalRequestStatus,
  ApprovalRequestSummary,
} from "@doxahq/contracts/approval-requests";
import type { AgentActor } from "@doxahq/api/services/agent-access/actor";
import type {
  AgentActionsRpc,
  AgentActionsRpcResult,
  ApprovalRequestTaskSource,
  PerformActionRpcOutput,
} from "@doxahq/api/services/agent-actions/rpc-contract";

/** doxa-api refused or failed an action; `code` comes from `describeKnownActionError`. */
export class PlatformActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PlatformActionError";
  }
}

export interface PerformActionCall {
  readonly action: AgentActionKind;
  readonly projectId: string | null;
  readonly payload: unknown;
  readonly summary: string | null;
}

/** What tools use to reach the actions RPC. The actor never comes from tool input. */
export interface PlatformActions {
  perform(call: PerformActionCall): Promise<PerformActionRpcOutput>;
  getRequest(requestId: string): Promise<ApprovalRequestDetail>;
  getRequestTask(requestId: string): Promise<ApprovalRequestTaskSource>;
  listRequests(status?: ApprovalRequestStatus): Promise<ApprovalRequestSummary[]>;
  cancelRequest(requestId: string): Promise<ApprovalRequestDetail>;
}

export function createPlatformActions(binding: AgentActionsRpc | undefined, actor: AgentActor): PlatformActions {
  const rpc = () => {
    if (binding === undefined) {
      throw new PlatformActionError("internal_error", "Doxa actions are not configured on this server.");
    }
    return binding;
  };
  const claims = actorClaims(actor);
  return {
    perform: async (call) => unwrap(await rpc().perform({ actor: claims, ...call })),
    getRequest: async (requestId) => unwrap(await rpc().getRequest({ actor: claims, requestId })),
    getRequestTask: async (requestId) => unwrap(await rpc().getRequestTask({ actor: claims, requestId })),
    listRequests: async (status) => unwrap(await rpc().listRequests({ actor: claims, status })),
    cancelRequest: async (requestId) => unwrap(await rpc().cancelRequest({ actor: claims, requestId })),
  };
}

function actorClaims(actor: AgentActor) {
  const { channel } = actor;
  return {
    userId: actor.principal.userId,
    clientId: channel.clientId,
    clientName: channel.clientName,
    grantRef: channel.grantRef,
    scopes: [...channel.scopes],
    projectScope:
      channel.projectScope.kind === "all"
        ? { kind: "all" as const }
        : { kind: "selected" as const, projectIds: [...channel.projectScope.projectIds] },
  };
}

function unwrap<T>(result: AgentActionsRpcResult<T>): T {
  if (result.ok) return result.value;
  throw new PlatformActionError(result.error.code, result.error.message);
}
