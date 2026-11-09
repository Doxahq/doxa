import type { z } from "zod";
import { agentActor } from "../agent-access/actor";
import { describeExecutionError } from "./action-error-codes";
import type { ApprovalService } from "./approval-service";
import { ActionInputError } from "./errors";
import type { AgentActionGateway } from "./gateway";
import { approvalUrlFor } from "./request-view";
import {
  listRequestsRpcInputSchema,
  performActionRpcInputSchema,
  requestRpcInputSchema,
  type AgentActionsRpc,
  type AgentActionsRpcResult,
} from "./rpc-contract";

export interface AgentActionsRpcDeps {
  readonly gateway: Pick<AgentActionGateway, "perform">;
  readonly approvals: Pick<ApprovalService, "get" | "listForAgent" | "cancel">;
  /** The dashboard origin of approval links. */
  readonly webOrigin: string;
}

/**
 * The logic behind `AgentActionsApi`, without the Worker runtime. It parses
 * every input again: a service binding is private, but doxa-api still owns
 * the access decision, so it rebuilds the actor and re-authorizes (spec 5.1).
 */
export class AgentActionsRpcHandler implements Omit<AgentActionsRpc, "compressImage"> {
  constructor(private readonly deps: AgentActionsRpcDeps) {}

  perform(raw: unknown) {
    return settle(async () => {
      const input = parse(performActionRpcInputSchema, raw);
      return this.deps.gateway.perform(agentActor(input.actor), {
        action: input.action,
        projectId: input.projectId,
        payload: input.payload,
        summary: input.summary,
      });
    });
  }

  getRequest(raw: unknown) {
    return settle(async () => {
      const input = parse(requestRpcInputSchema, raw);
      return this.deps.approvals.get(agentActor(input.actor), input.requestId);
    });
  }

  getRequestTask(raw: unknown) {
    return settle(async () => {
      const input = parse(requestRpcInputSchema, raw);
      const request = await this.deps.approvals.get(agentActor(input.actor), input.requestId);
      return { request, approvalUrl: approvalUrlFor(this.deps.webOrigin, request) };
    });
  }

  listRequests(raw: unknown) {
    return settle(async () => {
      const input = parse(listRequestsRpcInputSchema, raw);
      return this.deps.approvals.listForAgent(agentActor(input.actor), input.status);
    });
  }

  cancelRequest(raw: unknown) {
    return settle(async () => {
      const input = parse(requestRpcInputSchema, raw);
      return this.deps.approvals.cancel(agentActor(input.actor), input.requestId);
    });
  }
}

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ActionInputError("The action request is not valid.");
  return parsed.data;
}

async function settle<T>(work: () => Promise<T>): Promise<AgentActionsRpcResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: describeExecutionError(error) };
  }
}
