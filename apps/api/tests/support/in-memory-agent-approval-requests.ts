import type { ApprovalRequestError } from "@doxahq/contracts/approval-requests";
import type {
  AgentApprovalRequestStore,
  ApprovalRequestListFilter,
  ApprovalRequestRecord,
  NewApprovalRequest,
  PendingCursor,
  PendingInsertOutcome,
  TransitionOutcome,
} from "../../src/repositories/agent-approval-requests";
import {
  isAllowedTransition,
  REPLACED_ERROR,
  type ActiveApprovalStatus,
  type ApprovalTransition,
} from "../../src/services/agent-actions/approval-lifecycle";
import {
  toApprovalRequestId,
  type ApprovalRequestId,
} from "../../src/services/agent-actions/approval-request-id";

/** Same semantics as the Drizzle store, including the terminal state guard. */
export class InMemoryAgentApprovalRequestStore implements AgentApprovalRequestStore {
  readonly rows = new Map<string, ApprovalRequestRecord>();

  async insertPending(
    input: NewApprovalRequest,
    isSameRequest: (existing: ApprovalRequestRecord) => boolean,
    now: Date,
  ): Promise<PendingInsertOutcome> {
    const existing = this.pendingForTarget(input);
    if (existing && isSameRequest(existing)) return { kind: "reused", request: existing };
    if (existing) this.apply(existing, { to: "stale", error: REPLACED_ERROR }, now);
    const request: ApprovalRequestRecord = {
      ...input,
      id: toApprovalRequestId(crypto.randomUUID()),
      status: "pending",
      result: null,
      error: null,
      decidedByUserId: null,
      decisionNote: null,
      createdAt: now,
      updatedAt: now,
      decidedAt: null,
      completedAt: null,
    };
    this.rows.set(request.id, request);
    return { kind: "created", request, replaced: existing };
  }

  async findById(id: ApprovalRequestId): Promise<ApprovalRequestRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async list(filter: ApprovalRequestListFilter): Promise<ApprovalRequestRecord[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          (filter.projectId === undefined || row.projectId === filter.projectId) &&
          (filter.requestedByUserId === undefined ||
            row.requestedByUserId === filter.requestedByUserId) &&
          (filter.requestedByClientId === undefined ||
            row.requestedByClientId === filter.requestedByClientId) &&
          (filter.status === undefined || row.status === filter.status),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, filter.limit);
  }

  async transition(
    id: ApprovalRequestId,
    from: ActiveApprovalStatus,
    change: ApprovalTransition,
    now: Date,
  ): Promise<TransitionOutcome> {
    if (!isAllowedTransition(from, change.to)) {
      throw new Error(`Invalid approval transition ${from} -> ${change.to}`);
    }
    const row = this.rows.get(id);
    if (!row) return { kind: "not_found" };
    if (row.status !== from) return { kind: "conflict", request: row };
    return { kind: "applied", request: this.apply(row, change, now) };
  }

  async listPending(limit: number, after?: PendingCursor): Promise<ApprovalRequestRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.status === "pending" && (after === undefined || compareByAge(row, after) > 0))
      .sort(compareByAge)
      .slice(0, limit);
  }

  async expirePendingBefore(now: Date, error: ApprovalRequestError): Promise<number> {
    return this.bulk(
      (row) => row.status === "pending" && row.expiresAt < now,
      { to: "expired", error },
      now,
    );
  }

  async failExecutingDecidedBefore(
    cutoff: Date,
    error: ApprovalRequestError,
    now: Date,
  ): Promise<number> {
    return this.bulk(
      (row) => row.status === "executing" && row.decidedAt !== null && row.decidedAt < cutoff,
      { to: "failed", error },
      now,
    );
  }

  async expirePendingOfUnknownKinds(
    knownKinds: readonly string[],
    error: ApprovalRequestError,
    now: Date,
  ): Promise<number> {
    return this.bulk(
      (row) => row.status === "pending" && !knownKinds.includes(row.actionKind),
      { to: "expired", error },
      now,
    );
  }

  /** Test helper: seeds a row as-is. */
  seed(row: ApprovalRequestRecord): void {
    this.rows.set(row.id, row);
  }

  private bulk(
    matches: (row: ApprovalRequestRecord) => boolean,
    change: ApprovalTransition,
    now: Date,
  ): number {
    const targets = [...this.rows.values()].filter(matches);
    for (const row of targets) this.apply(row, change, now);
    return targets.length;
  }

  private pendingForTarget(input: NewApprovalRequest): ApprovalRequestRecord | null {
    for (const row of this.rows.values()) {
      if (
        row.status === "pending" &&
        row.projectId === input.projectId &&
        row.actionKind === input.actionKind &&
        row.targetKey === input.targetKey
      ) {
        return row;
      }
    }
    return null;
  }

  private apply(
    row: ApprovalRequestRecord,
    change: ApprovalTransition,
    now: Date,
  ): ApprovalRequestRecord {
    const next = { ...row, ...changedFields(change, now), status: change.to, updatedAt: now };
    this.rows.set(row.id, next);
    return next;
  }
}

function changedFields(change: ApprovalTransition, now: Date): Partial<ApprovalRequestRecord> {
  switch (change.to) {
    case "executing":
      return { decidedByUserId: change.decidedByUserId, decidedAt: now };
    case "completed":
      return { result: change.result ?? null, completedAt: now };
    case "rejected":
      return { decidedByUserId: change.decidedByUserId, decisionNote: change.note, decidedAt: now };
    case "cancelled":
      return { decidedByUserId: change.decidedByUserId, decidedAt: now, ...(change.error ? { error: change.error } : {}) };
    case "failed":
      return { error: change.error, completedAt: now };
    case "stale":
    case "expired":
      return { error: change.error };
  }
}

/** The Drizzle store's order: createdAt, then id. */
function compareByAge(a: PendingCursor, b: PendingCursor): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
