import type {
  ApprovalRequestDetail,
  ApprovalRequestSummary,
  PendingApprovalRequest,
} from "@doxahq/contracts/approval-requests";
import { APPROVAL_POLL_AFTER_MS } from "@doxahq/contracts/approval-requests";
import type { ApprovalRequestRecord } from "../../repositories/agent-approval-requests";
import type { ActionRegistry } from "./registry";
import type { PreparedAction, RegisteredAction } from "./registered-action";

const UNAVAILABLE = "This action is no longer available.";

interface BoundRecord {
  readonly action: RegisteredAction;
  readonly prepared: PreparedAction;
}

/** Null when a release removed the kind, or the stored row no longer parses. */
export function bindRecord(
  registry: ActionRegistry,
  record: Pick<ApprovalRequestRecord, "actionKind" | "payload" | "snapshot">,
): BoundRecord | null {
  const action = registry.find(record.actionKind);
  const prepared = action?.restore(record);
  return action && prepared ? { action, prepared } : null;
}

/** User display names by ID. A missing name reads as null. */
export type UserNames = ReadonlyMap<string, string>;

const NO_NAMES: UserNames = new Map();

/** The user IDs a summary names, for one directory lookup. */
export function namedUserIds(records: readonly ApprovalRequestRecord[]): string[] {
  return records.flatMap((record) =>
    record.decidedByUserId ? [record.requestedByUserId, record.decidedByUserId] : [record.requestedByUserId],
  );
}

/** Pure mapping from a stored row to the DTO the dashboard and agents read. */
export function toSummary(
  registry: ActionRegistry,
  record: ApprovalRequestRecord,
  names: UserNames = NO_NAMES,
): ApprovalRequestSummary {
  const bound = bindRecord(registry, record);
  return {
    id: record.id,
    projectId: record.projectId,
    actionKind: record.actionKind,
    actionAvailable: bound !== null,
    status: record.status,
    title: bound?.action.title ?? UNAVAILABLE,
    headline: bound?.prepared.description.headline ?? UNAVAILABLE,
    effects: bound ? [...bound.prepared.description.effects] : [],
    summary: record.summary,
    requestedBy: {
      userId: record.requestedByUserId,
      name: names.get(record.requestedByUserId) ?? null,
      clientName: record.requestedByClientName,
    },
    decidedBy: record.decidedByUserId
      ? { userId: record.decidedByUserId, name: names.get(record.decidedByUserId) ?? null }
      : null,
    decisionNote: record.decisionNote,
    policySource: record.policySource,
    reviewSurface: bound?.action.review ?? { kind: "approval_page" },
    branchId: bound?.prepared.branchId ?? null,
    confirmationText: bound?.prepared.confirmationText ?? null,
    error: record.error,
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    decidedAt: record.decidedAt?.toISOString() ?? null,
    completedAt: record.completedAt?.toISOString() ?? null,
  };
}

export function toDetail(
  registry: ActionRegistry,
  record: ApprovalRequestRecord,
  names: UserNames = NO_NAMES,
): ApprovalRequestDetail {
  const bound = bindRecord(registry, record);
  return {
    ...toSummary(registry, record, names),
    inputs: bound ? { ...bound.prepared.inputs } : {},
    result: record.result ?? null,
  };
}

export function approvalUrlFor(webOrigin: string, request: { readonly id: string }): string {
  return `${webOrigin}/approve/${request.id}`;
}

export function toPendingRequest(
  webOrigin: string,
  record: ApprovalRequestRecord,
): PendingApprovalRequest {
  return {
    id: record.id,
    status: "pending",
    approvalUrl: approvalUrlFor(webOrigin, record),
    expiresAt: record.expiresAt.toISOString(),
    pollAfterMs: APPROVAL_POLL_AFTER_MS,
  };
}
