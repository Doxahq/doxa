import type {
  ApprovalRequestDetail,
  ApprovalRequestLink,
  ApprovalRequestStatus,
  ApprovalRequestSummary,
  DashboardApprovalRequest,
} from "@doxahq/contracts/approval-requests";
import type { DocsPublishStage } from "@doxahq/contracts/docs-branches";
import type { AgentActivityStore } from "../../repositories/agent-activity";
import type { ApprovalSettingsStore } from "../../repositories/approval-settings";
import type { UserDirectory } from "../../repositories/user-directory";
import type {
  AgentApprovalRequestStore,
  ApprovalRequestRecord,
} from "../../repositories/agent-approval-requests";
import type { Actor, AgentActor, DashboardActor } from "../agent-access/actor";
import type { ActionContext, ActionExecution, ActionTarget } from "./action-definition";
import type { ActionAccessPolicy } from "./action-access";
import type { ActionServices } from "./action-ports";
import { describeExecutionError } from "./action-error-codes";
import { ApproveEligibility } from "./approve-eligibility";
import type { ApprovalNotifier } from "./approval-notifier";
import { toUserId } from "../agent-access/actor";
import { ACTION_REMOVED_ERROR, EXPIRED_ERROR, type ApprovalTransition } from "./approval-lifecycle";
import { decisionActivity, type DecisionTool } from "./decision-activity";
import {
  ActionAccessDeniedError,
  ActionUnavailableError,
  ApprovalRequestNotFoundError,
  ConfirmationMismatchError,
  OtherDeciderRequiredError,
  RequestNotPendingError,
} from "./errors";
import type { PreparedAction } from "./registered-action";
import type { ActionRegistry } from "./registry";
import { ApprovalRequestAccess } from "./request-access";
import { bindRecord, namedUserIds, toDetail, toSummary } from "./request-view";

export interface ApprovalServiceDeps {
  readonly registry: ActionRegistry;
  readonly requests: AgentApprovalRequestStore;
  readonly access: ActionAccessPolicy;
  readonly services: ActionServices;
  readonly activity: Pick<AgentActivityStore, "append">;
  /** Reads `require_other_decider` of the request's project. */
  readonly flags: Pick<ApprovalSettingsStore, "projectFlags">;
  /** Names the member who asked and the one who decided. */
  readonly users: UserDirectory;
  /** Keeps the activity write alive after the response (`waitUntil`). */
  readonly defer: (work: Promise<unknown>) => void;
  readonly now: () => Date;
  /** Emails the requester about the decision. */
  readonly notifier: ApprovalNotifier;
}

export interface ApproveOptions {
  readonly confirmation?: string;
  /** `docs.publish` only: overrides the agent's choice. */
  readonly eraseBranch?: boolean;
  readonly onProgress?: (stage: DocsPublishStage) => void;
}

const LIST_LIMIT = 100;

/** Spec 8.7: what the dashboard and the requesting agent can do with a request. */
export class ApprovalService {
  private readonly requestAccess: ApprovalRequestAccess;
  private readonly eligibility: ApproveEligibility;

  constructor(private readonly deps: ApprovalServiceDeps) {
    this.requestAccess = new ApprovalRequestAccess(deps.requests, deps.access);
    this.eligibility = new ApproveEligibility(deps);
  }

  async listForProject(
    actor: DashboardActor,
    projectId: string,
    status?: ApprovalRequestStatus,
  ): Promise<ApprovalRequestSummary[]> {
    const decision = await this.deps.access.authorize(actor, projectId, "project.read");
    if (!decision.allowed) throw new ApprovalRequestNotFoundError();
    const records = await this.deps.requests.list({ projectId, status, limit: LIST_LIMIT });
    const names = await this.deps.users.namesFor(namedUserIds(records));
    return records.map((record) => toSummary(this.deps.registry, record, names));
  }

  /** An agent sees only the requests that its own client made. */
  async listForAgent(actor: AgentActor, status?: ApprovalRequestStatus): Promise<ApprovalRequestSummary[]> {
    const records = await this.deps.requests.list({
      requestedByUserId: actor.principal.userId,
      requestedByClientId: actor.channel.clientId,
      status,
      limit: LIST_LIMIT,
    });
    const visible = await this.requestAccess.filterVisibleToAgent(actor, records);
    return visible.map((record) => toSummary(this.deps.registry, record));
  }

  async get(actor: Actor, requestId: string): Promise<ApprovalRequestDetail> {
    return this.detail(await this.requestAccess.loadVisible(actor, requestId));
  }

  /** The dashboard's detail: `get` plus whether this viewer may approve. */
  async review(actor: DashboardActor, requestId: string): Promise<DashboardApprovalRequest> {
    return this.dashboardDetail(actor, await this.requestAccess.loadVisible(actor, requestId));
  }

  /** What the web link `/approve/<id>` needs to open the right review surface. */
  async link(actor: DashboardActor, requestId: string): Promise<ApprovalRequestLink> {
    const summary = toSummary(this.deps.registry, await this.requestAccess.loadVisible(actor, requestId));
    return {
      id: summary.id,
      projectId: summary.projectId,
      actionKind: summary.actionKind,
      status: summary.status,
      reviewSurface: summary.reviewSurface,
      branchId: summary.branchId,
    };
  }

  async approve(actor: DashboardActor, requestId: string, options: ApproveOptions = {}): Promise<DashboardApprovalRequest> {
    const startedAt = this.deps.now().getTime();
    const record = await this.requestAccess.load(requestId);
    const target = await this.requestAccess.authorize(actor, record, "approvals.decide");
    await this.assertMayApprove(actor, record);
    const stored = await this.preparedOrExpire(record);
    await this.expireIfDue(record);
    assertPending(record);
    assertConfirmation(stored, options.confirmation);
    const prepared = stored.withChoices({ eraseBranch: options.eraseBranch });

    const executing = await this.apply(record, "pending", { to: "executing", decidedByUserId: actor.principal.userId });
    const finished = await this.runApproved(executing, target, prepared, actor, options.onProgress);
    this.recordDecision(finished.request, "approve_request", startedAt, finished.persisted);
    this.deps.notifier.decided(finished.request, "approved");
    return this.dashboardDetail(actor, finished.request);
  }

  async reject(actor: DashboardActor, requestId: string, reason?: string): Promise<DashboardApprovalRequest> {
    const startedAt = this.deps.now().getTime();
    const record = await this.requestAccess.load(requestId);
    await this.requestAccess.authorize(actor, record, "approvals.decide");
    const note = reason && reason.length > 0 ? reason : null;
    const rejected = await this.apply(record, "pending", {
      to: "rejected",
      decidedByUserId: actor.principal.userId,
      note,
    });
    this.recordDecision(rejected, "reject_request", startedAt, true);
    this.deps.notifier.decided(rejected, "rejected");
    return this.dashboardDetail(actor, rejected);
  }

  /** The requesting client, or a user who can decide, may cancel a pending request. */
  async cancel(actor: Actor, requestId: string): Promise<ApprovalRequestDetail> {
    const record = await this.requestAccess.load(requestId);
    if (actor.channel.kind === "agent") {
      if (!(await this.requestAccess.isVisibleToAgent({ ...actor, channel: actor.channel }, record))) {
        throw new ApprovalRequestNotFoundError();
      }
    } else {
      await this.requestAccess.authorize(actor, record, "approvals.decide");
    }
    const decidedBy = actor.channel.kind === "dashboard" ? actor.principal.userId : null;
    const cancelled = await this.apply(record, "pending", { to: "cancelled", decidedByUserId: decidedBy });
    return this.detail(cancelled);
  }

  private async detail(record: ApprovalRequestRecord): Promise<ApprovalRequestDetail> {
    const names = await this.deps.users.namesFor(namedUserIds([record]));
    return toDetail(this.deps.registry, record, names);
  }

  private async dashboardDetail(actor: DashboardActor, record: ApprovalRequestRecord): Promise<DashboardApprovalRequest> {
    const [detail, viewer] = await Promise.all([this.detail(record), this.eligibility.check(actor, record)]);
    return { ...detail, viewer };
  }

  /** Enforces the rule that the dashboard detail shows as `viewer`. */
  private async assertMayApprove(actor: DashboardActor, record: ApprovalRequestRecord): Promise<void> {
    const viewer = await this.eligibility.check(actor, record);
    if (viewer.canApprove) return;
    switch (viewer.reason) {
      case "other_decider_required":
        throw new OtherDeciderRequiredError();
      case "missing_capability":
        throw new ActionAccessDeniedError("forbidden");
    }
  }

  /**
   * SEC-029: a request past its expiry is never approved, also before the
   * 5-minute sweeper has marked it. It is expired here, the same way.
   */
  private async expireIfDue(record: ApprovalRequestRecord): Promise<void> {
    if (record.status !== "pending" || record.expiresAt > this.deps.now()) return;
    await this.deps.requests.transition(record.id, "pending", { to: "expired", error: EXPIRED_ERROR }, this.deps.now());
    throw new RequestNotPendingError("expired");
  }

  private async preparedOrExpire(record: ApprovalRequestRecord): Promise<PreparedAction> {
    const bound = bindRecord(this.deps.registry, record);
    if (bound) return bound.prepared;
    if (record.status === "pending") {
      await this.deps.requests.transition(record.id, "pending", { to: "expired", error: ACTION_REMOVED_ERROR }, this.deps.now());
    }
    throw new ActionUnavailableError();
  }

  private async runApproved(
    record: ApprovalRequestRecord,
    target: ActionTarget,
    prepared: PreparedAction,
    decider: DashboardActor,
    onProgress: ApproveOptions["onProgress"],
  ): Promise<{ request: ApprovalRequestRecord; persisted: boolean }> {
    const context: ActionContext = { target, services: this.deps.services };
    const freshness = await prepared.checkFresh(context);
    if (!freshness.fresh) {
      const error = { code: freshness.reason, message: freshness.message };
      return { request: await this.apply(record, "executing", { to: "stale", error }), persisted: true };
    }
    const execution: ActionExecution = {
      ...context,
      requester: requesterOfRecord(record),
      decision: { kind: "approved", requestId: record.id, decidedByUserId: decider.principal.userId },
      onProgress,
    };
    try {
      const result = await prepared.execute(execution);
      return this.finish(record, { to: "completed", result });
    } catch (error) {
      return this.finish(record, { to: "failed", error: describeExecutionError(error) });
    }
  }

  /** A completed `project.delete` removes its own row by cascade; keep the outcome in memory. */
  private async finish(
    record: ApprovalRequestRecord,
    change: Extract<ApprovalTransition, { to: "completed" | "failed" }>,
  ): Promise<{ request: ApprovalRequestRecord; persisted: boolean }> {
    const now = this.deps.now();
    const outcome = await this.deps.requests.transition(record.id, "executing", change, now);
    if (outcome.kind === "applied") return { request: outcome.request, persisted: true };
    if (outcome.kind === "conflict") throw new RequestNotPendingError(outcome.request.status);
    const result = change.to === "completed" ? change.result : null;
    const error = change.to === "failed" ? change.error : null;
    return {
      request: { ...record, status: change.to, result, error, completedAt: now, updatedAt: now },
      persisted: false,
    };
  }

  private async apply(
    record: ApprovalRequestRecord,
    from: "pending" | "executing",
    change: ApprovalTransition,
  ): Promise<ApprovalRequestRecord> {
    const outcome = await this.deps.requests.transition(record.id, from, change, this.deps.now());
    if (outcome.kind === "applied") return outcome.request;
    if (outcome.kind === "conflict") throw new RequestNotPendingError(outcome.request.status);
    throw new ApprovalRequestNotFoundError();
  }

  private recordDecision(request: ApprovalRequestRecord, tool: DecisionTool, startedAt: number, persisted: boolean): void {
    const durationMs = this.deps.now().getTime() - startedAt;
    const write = this.deps.activity
      .append(decisionActivity({ request, tool, durationMs, persisted }))
      .catch((error: unknown) => console.error("Agent decision activity write failed.", error));
    this.deps.defer(write);
  }
}

function assertPending(record: ApprovalRequestRecord): void {
  if (record.status !== "pending") throw new RequestNotPendingError(record.status);
}

function assertConfirmation(prepared: PreparedAction, confirmation: string | undefined): void {
  if (prepared.confirmationText === null) return;
  if (confirmation?.trim() !== prepared.confirmationText) throw new ConfirmationMismatchError();
}

function requesterOfRecord(record: ApprovalRequestRecord): ActionExecution["requester"] {
  return {
    userId: toUserId(record.requestedByUserId),
    clientId: record.requestedByClientId,
    clientName: record.requestedByClientName,
    grantRef: record.grantRef,
  };
}
