import type {
  AgentActionKind,
  ApprovalRequestSummary,
  PendingApprovalRequest,
} from "@doxahq/contracts/approval-requests";
import type { AgentApprovalRequestStore } from "../../repositories/agent-approval-requests";
import type { AgentActor } from "../agent-access/actor";
import type { ActionContext, ActionTarget } from "./action-definition";
import type { ApprovalNotifier } from "./approval-notifier";
import type { ActionServices } from "./action-ports";
import {
  authorizeActionTarget,
  requesterOf,
  storedTargetKey,
  type ActionAccessPolicy,
} from "./action-access";
import { ActionDeniedError, ActionStaleError } from "./errors";
import type { ApprovalPolicyResolver, ResolvedApprovalMode } from "./policy/approval-policy";
import type { PreparedAction, RegisteredAction } from "./registered-action";
import type { ActionRegistry } from "./registry";
import { isRequestingAgent } from "./request-access";
import { toPendingRequest, toSummary } from "./request-view";

export interface PerformActionRequest {
  readonly action: AgentActionKind;
  /** Null only for `project.create`. */
  readonly projectId: string | null;
  readonly payload: unknown;
  /** The agent's text for the reviewer, at most 500 characters. */
  readonly summary: string | null;
}

export type PerformActionResult =
  | { readonly outcome: "completed"; readonly result: unknown; readonly policySource: string }
  | {
      readonly outcome: "approval_required";
      readonly request: ApprovalRequestSummary;
      readonly pending: PendingApprovalRequest;
      readonly message: string;
      readonly policySource: string;
    };

export interface AgentActionGatewayDeps {
  readonly registry: ActionRegistry;
  readonly access: ActionAccessPolicy;
  readonly policy: Pick<ApprovalPolicyResolver, "resolve">;
  readonly requests: Pick<AgentApprovalRequestStore, "insertPending">;
  readonly services: ActionServices;
  readonly webOrigin: string;
  readonly now: () => Date;
  /** Emails the members who can approve a new request. */
  readonly notifier: ApprovalNotifier;
}

const HOUR_MS = 60 * 60 * 1000;

/** Spec 8.5: the one entry for consequential agent actions. */
export class AgentActionGateway {
  constructor(private readonly deps: AgentActionGatewayDeps) {}

  async perform(actor: AgentActor, request: PerformActionRequest): Promise<PerformActionResult> {
    const action = this.deps.registry.get(request.action);
    const target = await authorizeActionTarget(
      this.deps.access,
      actor,
      action,
      request.projectId,
      action.capability,
    );
    const resolved = await this.deps.policy.resolve({
      actor,
      projectId: target.kind === "project" ? target.projectId : null,
      action: request.action,
    });
    if (resolved.mode === "deny") throw new ActionDeniedError(request.action, resolved.source);

    const context: ActionContext = { target, services: this.deps.services };
    const prepared = await action.prepare(context, request.payload);
    if (resolved.mode === "allow") {
      return { outcome: "completed", result: await runNow(actor, context, prepared), policySource: resolved.source };
    }
    return this.requestApproval(actor, { action, target, prepared, resolved, summary: request.summary });
  }

  private async requestApproval(
    actor: AgentActor,
    input: {
      action: RegisteredAction;
      target: ActionTarget;
      prepared: PreparedAction;
      resolved: ResolvedApprovalMode;
      summary: string | null;
    },
  ): Promise<PerformActionResult> {
    const { action, target, prepared, resolved } = input;
    const now = this.deps.now();
    const requester = requesterOf(actor);
    const outcome = await this.deps.requests.insertPending(
      {
        projectId: target.kind === "project" ? target.projectId : null,
        actionKind: action.kind,
        targetKey: storedTargetKey(target, prepared.targetKey),
        payloadVersion: action.payloadVersion,
        payload: prepared.payload,
        snapshot: prepared.snapshot,
        summary: input.summary,
        requestedByUserId: requester.userId,
        requestedByClientId: requester.clientId,
        requestedByClientName: requester.clientName,
        grantRef: requester.grantRef,
        policySource: resolved.source,
        expiresAt: new Date(now.getTime() + action.approval.ttlHours * HOUR_MS),
      },
      // Reuse only the caller's own request: another agent (another client,
      // or another member's in a team) could not read the reused ID, and
      // `require_other_decider` would check the wrong requester.
      (existing) => isRequestingAgent(actor, existing) && prepared.matches(existing),
      now,
    );
    // A reused request was announced when it was created.
    if (outcome.kind === "created") this.deps.notifier.requested(outcome.request);
    const pending = toPendingRequest(this.deps.webOrigin, outcome.request);
    return {
      outcome: "approval_required",
      request: toSummary(this.deps.registry, outcome.request),
      pending,
      message: `Ask the user to approve "${prepared.description.headline}" at ${pending.approvalUrl}.`,
      policySource: resolved.source,
    };
  }
}

/** The allowed path runs the same `execute` as an approved request. */
async function runNow(
  actor: AgentActor,
  context: ActionContext,
  prepared: PreparedAction,
): Promise<unknown> {
  const freshness = await prepared.checkFresh(context);
  if (!freshness.fresh) throw new ActionStaleError(freshness.reason, freshness.message);
  return prepared.execute({ ...context, requester: requesterOf(actor), decision: { kind: "allowed" } });
}
