import type {
  ApprovalRequestError,
  ApprovalRequestStatus,
} from "@doxahq/contracts/approval-requests";
import type { ApprovalPolicySourceName } from "@doxahq/contracts/approval-settings";

/** The only states a row can leave. Terminal rows never change again. */
export type ActiveApprovalStatus = Extract<
  ApprovalRequestStatus,
  "pending" | "executing"
>;

export type ApprovalTransition =
  | { readonly to: "executing"; readonly decidedByUserId: string }
  | { readonly to: "completed"; readonly result: unknown }
  | { readonly to: "failed"; readonly error: ApprovalRequestError }
  | { readonly to: "stale"; readonly error: ApprovalRequestError }
  | {
      readonly to: "rejected";
      readonly decidedByUserId: string;
      readonly note: string | null;
    }
  | {
      readonly to: "cancelled";
      readonly decidedByUserId: string | null;
      /** Set when the cron cancels a request that a setting now blocks. */
      readonly error?: ApprovalRequestError;
    }
  | { readonly to: "expired"; readonly error: ApprovalRequestError };

type TransitionTarget = ApprovalTransition["to"];

/** Spec 8.6. `stale` leaves `executing` when `checkFresh` fails on approve. */
const ALLOWED_TRANSITIONS: Record<
  ActiveApprovalStatus,
  readonly TransitionTarget[]
> = {
  pending: ["executing", "rejected", "cancelled", "expired", "stale"],
  executing: ["completed", "failed", "stale"],
};

export function isAllowedTransition(
  from: ActiveApprovalStatus,
  to: TransitionTarget,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isActiveStatus(
  status: ApprovalRequestStatus,
): status is ActiveApprovalStatus {
  return status === "pending" || status === "executing";
}

/** A request created by an older replaced snapshot. */
export const REPLACED_ERROR: ApprovalRequestError = {
  code: "replaced",
  message: "A newer request for the same target replaced this request.",
};

export const EXPIRED_ERROR: ApprovalRequestError = {
  code: "expired",
  message: "Nobody decided this request before it expired.",
};

export const ACTION_REMOVED_ERROR: ApprovalRequestError = {
  code: "action_removed",
  message: "This action is no longer available.",
};

export const EXECUTION_INTERRUPTED_ERROR: ApprovalRequestError = {
  code: "execution_interrupted",
  message: "The action stopped before it finished. Ask the agent to try again.",
};

export const PAYLOAD_INVALID_ERROR: ApprovalRequestError = {
  code: "payload_invalid",
  message: "This request can no longer be read. Ask the agent to try again.",
};

const BLOCKED_BY: Readonly<Record<ApprovalPolicySourceName, string>> = {
  platform_override: "a platform setting",
  project_setting: "a project setting",
  user_setting: "a user setting",
  action_default: "the action's default",
};

/** A setting changed the action to `deny` while the request waited (spec §4). */
export function blockedError(source: ApprovalPolicySourceName): ApprovalRequestError {
  return { code: "blocked", message: `Blocked by ${BLOCKED_BY[source]}.` };
}

/** A row that stays `executing` longer than this lost its Worker. */
export const EXECUTION_TIMEOUT_MS = 15 * 60 * 1000;
