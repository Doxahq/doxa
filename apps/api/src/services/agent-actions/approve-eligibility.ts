import type {
  ApprovalRequestViewer,
  ApproveBlockReason,
} from "@doxahq/contracts/approval-requests";
import type { ApprovalSettingsStore } from "../../repositories/approval-settings";
import type { ApprovalRequestRecord } from "../../repositories/agent-approval-requests";
import type { DashboardActor } from "../agent-access/actor";
import type { Capability } from "../agent-access/capabilities";
import type { ActionAccessPolicy } from "./action-access";
import type { ActionRegistry } from "./registry";

export interface ApproveEligibilityDeps {
  readonly registry: ActionRegistry;
  readonly access: ActionAccessPolicy;
  /** Reads `require_other_decider` of the request's project. */
  readonly flags: Pick<ApprovalSettingsStore, "projectFlags">;
}

const ALLOWED: ApprovalRequestViewer = { canApprove: true, reason: null, canReject: true };

function blocked(reason: ApproveBlockReason, canReject: boolean): ApprovalRequestViewer {
  return { canApprove: false, reason, canReject };
}

/**
 * The one rule for "may this member approve or reject this request". The
 * approve and reject paths enforce it and the dashboard detail shows it, so
 * the UI never offers a decision that the server refuses.
 *
 * 1. Rejecting needs `approvals.decide`. Approving also needs, since it runs
 *    the action, the action's own capability: an editor can approve a
 *    publish, not a project delete.
 * 2. v2 spec §12 question 2: with `require_other_decider`, the member whose
 *    agent asked cannot approve; any other member can. Reject and cancel
 *    never run anything, so the rule leaves them open.
 */
export class ApproveEligibility {
  constructor(private readonly deps: ApproveEligibilityDeps) {}

  async check(actor: DashboardActor, record: ApprovalRequestRecord): Promise<ApprovalRequestViewer> {
    if (!(await this.canReject(actor, record))) return blocked("missing_capability", false);
    const action = this.deps.registry.find(record.actionKind);
    if (action && !(await this.allows(actor, record, action.capability))) {
      return blocked("missing_capability", true);
    }
    if (await this.needsOtherDecider(actor, record)) return blocked("other_decider_required", true);
    return ALLOWED;
  }

  /** The reject rule: `approvals.decide` on the request's project. */
  canReject(actor: DashboardActor, record: ApprovalRequestRecord): Promise<boolean> {
    return this.allows(actor, record, "approvals.decide");
  }

  /** A request without a project (`project.create`) is its requester's alone. */
  private async allows(actor: DashboardActor, record: ApprovalRequestRecord, capability: Capability): Promise<boolean> {
    if (record.projectId === null) return record.requestedByUserId === actor.principal.userId;
    const decision = await this.deps.access.authorize(actor, record.projectId, capability);
    return decision.allowed;
  }

  private async needsOtherDecider(actor: DashboardActor, record: ApprovalRequestRecord): Promise<boolean> {
    if (record.projectId === null || record.requestedByUserId !== actor.principal.userId) return false;
    const flags = await this.deps.flags.projectFlags(record.projectId);
    return flags?.requireOtherDecider === true;
  }
}
