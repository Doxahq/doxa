import type {
  AgentApprovalRequestStore,
  ApprovalRequestRecord,
} from "../../repositories/agent-approval-requests";
import { dashboardActor, type Actor, type AgentActor } from "../agent-access/actor";
import type { Capability } from "../agent-access/capabilities";
import type { ActionTarget } from "./action-definition";
import type { ActionAccessPolicy } from "./action-access";
import { parseApprovalRequestId } from "./approval-request-id";
import { ActionAccessDeniedError, ApprovalRequestNotFoundError } from "./errors";

/**
 * Who may see and decide a request. Any refusal reads as "not found", so a
 * request ID never reveals another user's project. Teams add `forbidden`.
 */
export class ApprovalRequestAccess {
  constructor(
    private readonly requests: Pick<AgentApprovalRequestStore, "findById">,
    private readonly access: ActionAccessPolicy,
  ) {}

  async load(rawId: string): Promise<ApprovalRequestRecord> {
    const id = parseApprovalRequestId(rawId);
    const record = id === null ? null : await this.requests.findById(id);
    if (record === null) throw new ApprovalRequestNotFoundError();
    return record;
  }

  /**
   * The dashboard reads with `project.read`; an agent reads only its own
   * requests, and only while its user still has a role on the project.
   */
  async loadVisible(actor: Actor, rawId: string): Promise<ApprovalRequestRecord> {
    const record = await this.load(rawId);
    const { channel } = actor;
    if (channel.kind === "agent") {
      if (!(await this.isVisibleToAgent({ ...actor, channel }, record))) throw new ApprovalRequestNotFoundError();
      return record;
    }
    await this.authorize(actor, record, "project.read");
    return record;
  }

  /**
   * The requesting client of the same user, while that user is still a
   * member (v2 spec §5: a member who left gets "not found" on every call).
   * Request tools need no scope, so only the role counts, not the grant.
   */
  async isVisibleToAgent(actor: AgentActor, record: ApprovalRequestRecord): Promise<boolean> {
    return isRequestingAgent(actor, record) && (await this.hasRole(actor, record.projectId));
  }

  /** The agent's own requests, without those of projects its user left. */
  async filterVisibleToAgent(
    actor: AgentActor,
    records: readonly ApprovalRequestRecord[],
  ): Promise<ApprovalRequestRecord[]> {
    const projectIds = new Set(records.flatMap((record) => (record.projectId === null ? [] : [record.projectId])));
    const allowed = new Set<string>();
    await Promise.all(
      [...projectIds].map(async (projectId) => {
        if (await this.hasRole(actor, projectId)) allowed.add(projectId);
      }),
    );
    return records.filter(
      (record) => isRequestingAgent(actor, record) && (record.projectId === null || allowed.has(record.projectId)),
    );
  }

  /** The target an approved action runs on, checked with `approvals.decide`. */
  authorize(actor: Actor, record: ApprovalRequestRecord, capability: Capability): Promise<ActionTarget> {
    return authorizeForRecord(this.access, actor, record, capability);
  }

  private async hasRole(actor: AgentActor, projectId: string | null): Promise<boolean> {
    if (projectId === null) return true;
    const decision = await this.access.authorize(dashboardActor(actor.principal.userId), projectId, "project.read");
    return decision.allowed;
  }
}

export function isOwnRequest(clientId: string, actor: Actor, record: ApprovalRequestRecord): boolean {
  return record.requestedByUserId === actor.principal.userId && record.requestedByClientId === clientId;
}

export function isRequestingAgent(actor: AgentActor, record: ApprovalRequestRecord): boolean {
  return isOwnRequest(actor.channel.clientId, actor, record);
}

async function authorizeForRecord(
  access: ActionAccessPolicy,
  actor: Actor,
  record: ApprovalRequestRecord,
  capability: Capability,
): Promise<ActionTarget> {
  if (record.projectId === null) {
    if (record.requestedByUserId !== actor.principal.userId) throw new ApprovalRequestNotFoundError();
    return { kind: "principal", userId: actor.principal.userId };
  }
  const decision = await access.authorize(actor, record.projectId, capability);
  if (decision.allowed) {
    return { kind: "project", projectId: decision.project.projectId, ownerUserId: decision.project.ownerUserId };
  }
  if (decision.reason === "forbidden") throw new ActionAccessDeniedError("forbidden");
  throw new ApprovalRequestNotFoundError();
}
