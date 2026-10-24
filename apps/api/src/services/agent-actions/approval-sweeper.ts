import type { AgentApprovalRequestStore, PendingCursor } from "../../repositories/agent-approval-requests";
import { dashboardActor, toProjectId, toUserId } from "../agent-access/actor";
import type { ActionAccessPolicy } from "./action-access";
import type { ActionServices } from "./action-ports";
import {
  ACTION_REMOVED_ERROR,
  blockedError,
  EXECUTION_INTERRUPTED_ERROR,
  EXECUTION_TIMEOUT_MS,
  EXPIRED_ERROR,
  PAYLOAD_INVALID_ERROR,
  type ApprovalTransition,
} from "./approval-lifecycle";
import { projectFreshness, type Freshness } from "./freshness";
import type { ApprovalPolicyResolver, ResolvedApprovalMode } from "./policy/approval-policy";
import type { ActionRegistry } from "./registry";
import { bindRecord } from "./request-view";
import type { AgentActionKind, ApprovalRequestError } from "@doxahq/contracts/approval-requests";
import type { ApprovalRequestRecord } from "../../repositories/agent-approval-requests";
import type { ActionTarget } from "./action-definition";

export interface ApprovalSweeperDeps {
  readonly registry: ActionRegistry;
  readonly requests: AgentApprovalRequestStore;
  readonly access: ActionAccessPolicy;
  readonly services: ActionServices;
  readonly policy: Pick<ApprovalPolicyResolver, "resolve">;
  readonly now: () => Date;
}

export interface ApprovalSweepReport {
  readonly expired: number;
  readonly removedKinds: number;
  readonly blocked: number;
  readonly interrupted: number;
  readonly stale: number;
}

/** Freshness checks per cron run; the oldest pending requests go first. */
const STALE_CHECK_LIMIT = 100;

type ModeResolver = (record: ApprovalRequestRecord, kind: AgentActionKind) => Promise<ResolvedApprovalMode>;

/** Pending requests read per page by the Block step, which reads every page. */
const BLOCK_CHECK_PAGE_SIZE = 100;

/** Spec 8.6 and 8.7: the cron moves requests that nobody will move. */
export class ApprovalSweeper {
  constructor(private readonly deps: ApprovalSweeperDeps) {}

  async run(): Promise<ApprovalSweepReport> {
    const now = this.deps.now();
    const { requests, registry } = this.deps;
    const expired = await requests.expirePendingBefore(now, EXPIRED_ERROR);
    const removedKinds = await requests.expirePendingOfUnknownKinds(registry.kinds, ACTION_REMOVED_ERROR, now);
    const cutoff = new Date(now.getTime() - EXECUTION_TIMEOUT_MS);
    const interrupted = await requests.failExecutingDecidedBefore(cutoff, EXECUTION_INTERRUPTED_ERROR, now);
    const blocked = await this.cancelBlocked();
    const stale = await this.markStale();
    return { expired, removedKinds, blocked, interrupted, stale };
  }

  /**
   * Spec §4: a pending request keeps its mode, except that a setting
   * changed to `deny` cancels it. The policy resolves again for the
   * requester, so the source order decides: a project setting that still
   * asks keeps a request pending although the user setting blocks it.
   */
  async cancelBlocked(): Promise<number> {
    const resolveMode = this.memoizedPolicy();
    let cancelled = 0;
    let after: PendingCursor | undefined;
    for (;;) {
      const page = await this.deps.requests.listPending(BLOCK_CHECK_PAGE_SIZE, after);
      for (const record of page) {
        if (await this.cancelIfBlocked(record, resolveMode)) cancelled += 1;
      }
      const last = page.at(-1);
      if (last === undefined || page.length < BLOCK_CHECK_PAGE_SIZE) return cancelled;
      after = { createdAt: last.createdAt, id: last.id };
    }
  }

  private async cancelIfBlocked(
    record: ApprovalRequestRecord,
    resolveMode: ModeResolver,
  ): Promise<boolean> {
    const action = this.deps.registry.find(record.actionKind);
    if (action === undefined) return false;
    const resolved = await resolveMode(record, action.kind);
    if (resolved.mode !== "deny") return false;
    const change: ApprovalTransition = { to: "cancelled", decidedByUserId: null, error: blockedError(resolved.source) };
    const outcome = await this.deps.requests.transition(record.id, "pending", change, this.deps.now());
    return outcome.kind === "applied";
  }

  /**
   * Many pending requests share a requester, project and action, so one run
   * resolves each combination once.
   */
  private memoizedPolicy(): ModeResolver {
    const resolved = new Map<string, Promise<ResolvedApprovalMode>>();
    return (record, kind) => {
      const key = JSON.stringify([record.requestedByUserId, record.projectId, kind]);
      const cached = resolved.get(key);
      if (cached !== undefined) return cached;
      const mode = this.deps.policy.resolve({
        actor: dashboardActor(record.requestedByUserId),
        projectId: record.projectId === null ? null : toProjectId(record.projectId),
        action: kind,
      });
      resolved.set(key, mode);
      return mode;
    };
  }

  /** Runs `checkFresh` on pending requests, so the dashboard stops offering stale ones. */
  async markStale(): Promise<number> {
    const pending = await this.deps.requests.listPending(STALE_CHECK_LIMIT);
    let marked = 0;
    for (const record of pending) {
      const error = await this.staleErrorOf(record);
      if (error === null) continue;
      const outcome = await this.deps.requests.transition(record.id, "pending", { to: "stale", error }, this.deps.now());
      if (outcome.kind === "applied") marked += 1;
    }
    return marked;
  }

  /** Null while the request can still run. */
  private async staleErrorOf(record: ApprovalRequestRecord): Promise<ApprovalRequestError | null> {
    const bound = bindRecord(this.deps.registry, record);
    if (bound === null) return PAYLOAD_INVALID_ERROR;
    const target = await this.targetOf(record);
    const freshness: Freshness =
      target === null
        ? projectFreshness(false)
        : await bound.prepared.checkFresh({ target, services: this.deps.services });
    return freshness.fresh ? null : { code: freshness.reason, message: freshness.message };
  }

  /**
   * The cron has no session; it reads as the requester. A requester who left
   * the project's team has no access, so their pending request goes stale.
   */
  private async targetOf(record: ApprovalRequestRecord): Promise<ActionTarget | null> {
    const userId = toUserId(record.requestedByUserId);
    if (record.projectId === null) return { kind: "principal", userId };
    const decision = await this.deps.access.authorize(dashboardActor(userId), record.projectId, "project.read");
    if (!decision.allowed) return null;
    return {
      kind: "project",
      projectId: decision.project.projectId,
      ownerUserId: decision.project.ownerUserId,
    };
  }
}
