import { and, eq, gt, inArray, isNull, lt, notInArray, or, desc, type SQL } from "drizzle-orm";
import { createDb, schema, type DbEnv, type DoxaDb } from "@doxahq/db";
import {
  approvalRequestErrorSchema,
  type ApprovalRequestError,
  type ApprovalRequestStatus,
} from "@doxahq/contracts/approval-requests";
import {
  isAllowedTransition,
  REPLACED_ERROR,
  type ActiveApprovalStatus,
  type ApprovalTransition,
} from "../services/agent-actions/approval-lifecycle";
import {
  toApprovalRequestId,
  type ApprovalRequestId,
} from "../services/agent-actions/approval-request-id";
import { isUniqueViolation } from "./postgres-errors";

export interface ApprovalRequestRecord {
  readonly id: ApprovalRequestId;
  readonly projectId: string | null;
  readonly actionKind: string;
  readonly targetKey: string;
  readonly status: ApprovalRequestStatus;
  readonly payloadVersion: number;
  readonly payload: unknown;
  readonly snapshot: unknown;
  readonly summary: string | null;
  readonly result: unknown;
  readonly error: ApprovalRequestError | null;
  readonly requestedByUserId: string;
  readonly requestedByClientId: string;
  readonly requestedByClientName: string;
  readonly grantRef: string;
  readonly decidedByUserId: string | null;
  readonly decisionNote: string | null;
  readonly policySource: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly decidedAt: Date | null;
  readonly completedAt: Date | null;
  readonly expiresAt: Date;
}

export type NewApprovalRequest = Pick<
  ApprovalRequestRecord,
  | "projectId"
  | "actionKind"
  | "targetKey"
  | "payloadVersion"
  | "payload"
  | "snapshot"
  | "summary"
  | "requestedByUserId"
  | "requestedByClientId"
  | "requestedByClientName"
  | "grantRef"
  | "policySource"
  | "expiresAt"
>;

export type PendingInsertOutcome =
  | { readonly kind: "reused"; readonly request: ApprovalRequestRecord }
  | {
      readonly kind: "created";
      readonly request: ApprovalRequestRecord;
      readonly replaced: ApprovalRequestRecord | null;
    };

export type TransitionOutcome =
  | { readonly kind: "applied"; readonly request: ApprovalRequestRecord }
  | { readonly kind: "not_found" }
  /** The row was not in the expected state; `request` is its current state. */
  | { readonly kind: "conflict"; readonly request: ApprovalRequestRecord };

export interface ApprovalRequestListFilter {
  readonly projectId?: string;
  readonly requestedByUserId?: string;
  readonly requestedByClientId?: string;
  readonly status?: ApprovalRequestStatus;
  readonly limit: number;
}

/** Where a page of pending requests ends; the next page starts after it. */
export interface PendingCursor {
  readonly createdAt: Date;
  readonly id: ApprovalRequestId;
}

export interface AgentApprovalRequestStore {
  /**
   * Inserts a pending request. A pending request for the same target is
   * returned when `isSameRequest` accepts it, else marked stale and replaced.
   */
  insertPending(
    input: NewApprovalRequest,
    isSameRequest: (existing: ApprovalRequestRecord) => boolean,
    now: Date,
  ): Promise<PendingInsertOutcome>;
  findById(id: ApprovalRequestId): Promise<ApprovalRequestRecord | null>;
  list(filter: ApprovalRequestListFilter): Promise<ApprovalRequestRecord[]>;
  /** Locks the row and applies the change only while it is in `from`. */
  transition(
    id: ApprovalRequestId,
    from: ActiveApprovalStatus,
    change: ApprovalTransition,
    now: Date,
  ): Promise<TransitionOutcome>;
  /** Pending requests, oldest first by (createdAt, id), after `after` when given. */
  listPending(limit: number, after?: PendingCursor): Promise<ApprovalRequestRecord[]>;
  expirePendingBefore(now: Date, error: ApprovalRequestError): Promise<number>;
  failExecutingDecidedBefore(
    cutoff: Date,
    error: ApprovalRequestError,
    now: Date,
  ): Promise<number>;
  expirePendingOfUnknownKinds(
    knownKinds: readonly string[],
    error: ApprovalRequestError,
    now: Date,
  ): Promise<number>;
}

type Row = typeof schema.agentApprovalRequests.$inferSelect;
type Tx = Parameters<Parameters<DoxaDb["transaction"]>[0]>[0];

const table = schema.agentApprovalRequests;
const PENDING_TARGET_INDEX = "agent_approval_requests_pending_target_idx";

export class AgentApprovalRequestsRepository implements AgentApprovalRequestStore {
  private readonly db: DoxaDb;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  async insertPending(
    input: NewApprovalRequest,
    isSameRequest: (existing: ApprovalRequestRecord) => boolean,
    now: Date,
  ): Promise<PendingInsertOutcome> {
    try {
      return await this.insertPendingOnce(input, isSameRequest, now);
    } catch (cause) {
      // A concurrent insert for the same target won the unique index; the
      // second attempt sees its row and reuses or replaces it.
      if (!isUniqueViolation(cause, PENDING_TARGET_INDEX)) throw cause;
      return this.insertPendingOnce(input, isSameRequest, now);
    }
  }

  async findById(id: ApprovalRequestId): Promise<ApprovalRequestRecord | null> {
    const [row] = await this.db.select().from(table).where(eq(table.id, id)).limit(1);
    return row ? toRecord(row) : null;
  }

  async list(filter: ApprovalRequestListFilter): Promise<ApprovalRequestRecord[]> {
    const rows = await this.db
      .select()
      .from(table)
      .where(and(...listConditions(filter)))
      .orderBy(desc(table.createdAt), desc(table.id))
      .limit(filter.limit);
    return rows.map(toRecord);
  }

  transition(
    id: ApprovalRequestId,
    from: ActiveApprovalStatus,
    change: ApprovalTransition,
    now: Date,
  ): Promise<TransitionOutcome> {
    if (!isAllowedTransition(from, change.to)) {
      throw new Error(`Invalid approval transition ${from} -> ${change.to}`);
    }
    return this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(table).where(eq(table.id, id)).for("update").limit(1);
      if (!locked) return { kind: "not_found" };
      if (locked.status !== from) return { kind: "conflict", request: toRecord(locked) };
      const [updated] = await tx
        .update(table)
        .set(transitionColumns(change, now))
        .where(eq(table.id, id))
        .returning();
      if (!updated) throw new Error("Approval transition returned no row");
      return { kind: "applied", request: toRecord(updated) };
    });
  }

  async listPending(limit: number, after?: PendingCursor): Promise<ApprovalRequestRecord[]> {
    const afterCursor =
      after === undefined
        ? undefined
        : or(
            gt(table.createdAt, after.createdAt),
            and(eq(table.createdAt, after.createdAt), gt(table.id, after.id)),
          );
    const rows = await this.db
      .select()
      .from(table)
      .where(and(eq(table.status, "pending"), afterCursor))
      .orderBy(table.createdAt, table.id)
      .limit(limit);
    return rows.map(toRecord);
  }

  expirePendingBefore(now: Date, error: ApprovalRequestError): Promise<number> {
    return this.bulkTransition(
      and(eq(table.status, "pending"), lt(table.expiresAt, now)),
      { to: "expired", error },
      now,
    );
  }

  failExecutingDecidedBefore(cutoff: Date, error: ApprovalRequestError, now: Date): Promise<number> {
    return this.bulkTransition(
      and(eq(table.status, "executing"), lt(table.decidedAt, cutoff)),
      { to: "failed", error },
      now,
    );
  }

  expirePendingOfUnknownKinds(
    knownKinds: readonly string[],
    error: ApprovalRequestError,
    now: Date,
  ): Promise<number> {
    return this.bulkTransition(
      and(eq(table.status, "pending"), notInArray(table.actionKind, [...knownKinds])),
      { to: "expired", error },
      now,
    );
  }

  private async bulkTransition(
    where: SQL | undefined,
    change: ApprovalTransition,
    now: Date,
  ): Promise<number> {
    const rows = await this.db
      .update(table)
      .set(transitionColumns(change, now))
      .where(where)
      .returning({ id: table.id });
    return rows.length;
  }

  private insertPendingOnce(
    input: NewApprovalRequest,
    isSameRequest: (existing: ApprovalRequestRecord) => boolean,
    now: Date,
  ): Promise<PendingInsertOutcome> {
    return this.db.transaction(async (tx) => {
      const existing = await lockPendingForTarget(tx, input);
      if (existing && isSameRequest(existing)) return { kind: "reused", request: existing };
      if (existing) {
        await tx
          .update(table)
          .set(transitionColumns({ to: "stale", error: REPLACED_ERROR }, now))
          .where(and(eq(table.id, existing.id), eq(table.status, "pending")));
      }
      const [inserted] = await tx
        .insert(table)
        .values({ ...input, status: "pending", createdAt: now, updatedAt: now })
        .returning();
      if (!inserted) throw new Error("Approval request insert returned no row");
      return { kind: "created", request: toRecord(inserted), replaced: existing };
    });
  }
}

async function lockPendingForTarget(
  tx: Tx,
  input: Pick<NewApprovalRequest, "projectId" | "actionKind" | "targetKey">,
): Promise<ApprovalRequestRecord | null> {
  const [row] = await tx
    .select()
    .from(table)
    .where(
      and(
        input.projectId === null ? isNull(table.projectId) : eq(table.projectId, input.projectId),
        eq(table.actionKind, input.actionKind),
        eq(table.targetKey, input.targetKey),
        eq(table.status, "pending"),
      ),
    )
    .for("update")
    .limit(1);
  return row ? toRecord(row) : null;
}

function listConditions(filter: ApprovalRequestListFilter): SQL[] {
  const conditions: SQL[] = [];
  if (filter.projectId !== undefined) conditions.push(eq(table.projectId, filter.projectId));
  if (filter.requestedByUserId !== undefined) {
    conditions.push(eq(table.requestedByUserId, filter.requestedByUserId));
  }
  if (filter.requestedByClientId !== undefined) {
    conditions.push(eq(table.requestedByClientId, filter.requestedByClientId));
  }
  if (filter.status !== undefined) conditions.push(inArray(table.status, [filter.status]));
  return conditions;
}

/** The columns one transition writes. Shared by the row and the bulk updates. */
export function transitionColumns(
  change: ApprovalTransition,
  now: Date,
): Partial<typeof table.$inferInsert> {
  const base = { status: change.to, updatedAt: now };
  switch (change.to) {
    case "executing":
      return { ...base, decidedByUserId: change.decidedByUserId, decidedAt: now };
    case "completed":
      return { ...base, result: change.result ?? null, completedAt: now };
    case "rejected":
      return { ...base, decidedByUserId: change.decidedByUserId, decisionNote: change.note, decidedAt: now };
    case "cancelled":
      return {
        ...base,
        decidedByUserId: change.decidedByUserId,
        decidedAt: now,
        ...(change.error ? { error: change.error } : {}),
      };
    case "failed":
      return { ...base, error: change.error, completedAt: now };
    case "stale":
    case "expired":
      return { ...base, error: change.error };
  }
}

function toRecord(row: Row): ApprovalRequestRecord {
  const error = approvalRequestErrorSchema.safeParse(row.error);
  return { ...row, id: toApprovalRequestId(row.id), error: error.success ? error.data : null };
}

