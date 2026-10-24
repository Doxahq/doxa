import type { ApprovalRequestRecord } from "../../repositories/agent-approval-requests";

export type ApprovalDecision = "approved" | "rejected";

/**
 * Tells people about approval requests (email spec §10). The action layer
 * calls it after the change commits. It never throws and never delays the
 * response: an implementation runs its work in the background.
 */
export interface ApprovalNotifier {
  requested(request: ApprovalRequestRecord): void;
  decided(request: ApprovalRequestRecord, decision: ApprovalDecision): void;
}

export const SILENT_APPROVAL_NOTIFIER: ApprovalNotifier = {
  requested: () => undefined,
  decided: () => undefined,
};
