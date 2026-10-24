import type { z } from "zod";
import type { OAuthScope } from "@doxahq/contracts/agent-access";
import type { AgentActionKind, ReviewSurface } from "@doxahq/contracts/approval-requests";
import type { DocsPublishStage } from "@doxahq/contracts/docs-branches";
import type { PublicationAttribution } from "../../repositories/docs-publications";
import type { ProjectId, UserId } from "../agent-access/actor";
import type { Capability } from "../agent-access/capabilities";
import type { ActionServices } from "./action-ports";
import type { ApprovalRequestId } from "./approval-request-id";
import type { Freshness } from "./freshness";
import type { ApprovalMode } from "./policy/approval-policy";

export interface ActionApprovalRules {
  readonly defaultMode: ApprovalMode;
  /** The floor and the ceiling for every policy source. */
  readonly allowedModes: readonly ApprovalMode[];
  /** A pending request expires after this time. */
  readonly ttlHours: number;
}

/** The project an action changes, after the access policy authorized it. */
export interface ProjectTarget {
  readonly kind: "project";
  readonly projectId: ProjectId;
  /** Services that need a user ID get this one (spec 7.4). */
  readonly ownerUserId: UserId;
}

/** `project.create` has no project yet; it acts for the principal only. */
export interface PrincipalTarget {
  readonly kind: "principal";
  readonly userId: UserId;
}

export type ActionTarget = ProjectTarget | PrincipalTarget;

export interface ActionContext<TTarget extends ActionTarget = ActionTarget> {
  readonly target: TTarget;
  readonly services: ActionServices;
}

/** The agent that asked for the action. */
export interface ActionRequester {
  readonly userId: UserId;
  readonly clientId: string;
  readonly clientName: string;
  readonly grantRef: string;
}

/** Spec 8.10: who let the action run. */
export type ActionDecision =
  | { readonly kind: "allowed" }
  | {
      readonly kind: "approved";
      readonly requestId: ApprovalRequestId;
      readonly decidedByUserId: UserId;
    };

export interface ActionExecution<TTarget extends ActionTarget = ActionTarget>
  extends ActionContext<TTarget> {
  readonly requester: ActionRequester;
  readonly decision: ActionDecision;
  /** Receives publish stages for an SSE response. */
  readonly onProgress?: (stage: DocsPublishStage) => void;
}

export interface ActionDescription {
  /** "Publish 3 changes from agent-rate-limits" */
  readonly headline: string;
  /** "The live site at acme.doxa.page changes." */
  readonly effects: readonly string[];
}

export type ReviewInputs = Readonly<Record<string, string | number | boolean | null>>;

/** Options that the decider picks when they approve a request. */
export interface ApprovalChoices {
  readonly eraseBranch?: boolean;
}

export interface AgentActionDefinition<
  K extends AgentActionKind,
  TTarget extends ActionTarget,
  TPayload,
  TSnapshot,
  TResult,
> {
  readonly kind: K;
  readonly payloadVersion: number;
  /** "Publish a branch" */
  readonly title: string;
  /** The OAuth scope of the MCP tool that calls this action. */
  readonly scope: OAuthScope;
  readonly capability: Capability;
  readonly payloadSchema: z.ZodType<TPayload>;
  readonly snapshotSchema: z.ZodType<TSnapshot>;
  readonly resultSchema: z.ZodType<TResult>;
  readonly approval: ActionApprovalRules;
  readonly review: ReviewSurface;
  /** Names the target, so one target has at most one pending request. */
  targetKey(payload: TPayload): string;
  describe(payload: TPayload, snapshot: TSnapshot): ActionDescription;
  /** The payload fields the approval page shows. */
  reviewInputs(payload: TPayload): ReviewInputs;
  /** Set for destructive actions: the text the decider must type. */
  confirmationText?(payload: TPayload, snapshot: TSnapshot): string;
  /** Set for actions reviewed in the publish menu, to open the branch. */
  branchId?(payload: TPayload): string;
  /** Set for actions with decider choices: the payload that runs on approve. */
  applyChoices?(payload: TPayload, choices: ApprovalChoices): TPayload;
  /** Records the preconditions when the request starts. */
  capture(context: ActionContext<TTarget>, payload: TPayload): Promise<TSnapshot>;
  checkFresh(
    context: ActionContext<TTarget>,
    payload: TPayload,
    snapshot: TSnapshot,
  ): Promise<Freshness>;
  /** The only place that calls the side-effect service, for both paths. */
  execute(
    execution: ActionExecution<TTarget>,
    payload: TPayload,
    snapshot: TSnapshot,
  ): Promise<TResult>;
}

/** Publications made by an action carry the agent and the request. */
export function attributionOf(execution: ActionExecution): PublicationAttribution {
  return {
    agentClientId: execution.requester.clientId,
    agentClientName: execution.requester.clientName,
    approvalRequestId:
      execution.decision.kind === "approved" ? execution.decision.requestId : null,
  };
}

/** v1: every gated request waits one week. */
export const DEFAULT_TTL_HOURS = 168;

export const ALL_APPROVAL_MODES: readonly ApprovalMode[] = ["allow", "require_approval", "deny"];
