import type { ApprovalMode } from "@doxahq/contracts/approval-settings";
import type { AgentActivityRecord } from "../../repositories/agent-activity";
import type { PolicyScope } from "../../repositories/approval-settings";

/** One change of an approval setting, kept in `agent_activity.details`. */
export type ApprovalSettingChange =
  | {
      readonly kind: "approval_mode";
      readonly scope: PolicyScope["kind"];
      readonly actionKind: string;
      /** Null when the setting was not set before. */
      readonly from: ApprovalMode | null;
      /** Null when the change cleared the setting. */
      readonly to: ApprovalMode | null;
    }
  | {
      readonly kind: "erase_branch_after_publish" | "require_other_decider";
      readonly from: boolean;
      readonly to: boolean;
    };

export const APPROVAL_SETTINGS_TOOL = "update_approval_settings";

/**
 * A person changes settings in the dashboard, not through an agent grant.
 * The activity columns that name the agent get these fixed values.
 */
export const DASHBOARD_CLIENT = {
  clientId: "dashboard",
  clientName: "Doxa dashboard",
  grantRef: "dashboard",
} as const;

/** Pure: the activity row for one approval setting change. */
export function settingActivity(input: {
  userId: string;
  projectId: string | null;
  change: ApprovalSettingChange;
  durationMs: number;
}): AgentActivityRecord {
  const { change } = input;
  return {
    userId: input.userId,
    ...DASHBOARD_CLIENT,
    projectId: input.projectId,
    tool: APPROVAL_SETTINGS_TOOL,
    actionKind: change.kind === "approval_mode" ? change.actionKind : null,
    approvalRequestId: null,
    outcome: "succeeded",
    errorCode: null,
    policySource: null,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    inputSha256: null,
    details: change,
  };
}
