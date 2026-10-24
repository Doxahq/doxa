import type { AgentActionKind } from "@doxahq/contracts/approval-requests"
import {
  APPROVAL_MODES,
  approvalPolicySourceSchema,
  type ApprovalActionSetting,
  type ApprovalMode,
  type ApprovalModeChanges,
  type ApprovalPolicySourceName,
  type ProjectApprovalSettings,
} from "@doxahq/contracts/approval-settings"

/** One choice of a segmented control. */
export interface ChoiceOption<TValue extends string> {
  value: TValue
  label: string
  disabled?: boolean
}

export const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = {
  allow: "Allow",
  require_approval: "Ask me",
  deny: "Block",
}

const SOURCE_LABELS: Record<ApprovalPolicySourceName, string> = {
  platform_override: "a Doxa platform rule",
  project_setting: "the project setting",
  user_setting: "your default",
  action_default: "the Doxa default",
}

/** "Asked because of the project setting." Explains why a gate applied. */
export function policySourceLabel(source: string): string {
  const known = approvalPolicySourceSchema.safeParse(source)
  return known.success ? SOURCE_LABELS[known.data] : "a setting"
}

/** Every mode in a fixed order; the ones the action forbids stay visible but disabled. */
export function approvalModeOptions(setting: Pick<ApprovalActionSetting, "allowedModes">): ChoiceOption<ApprovalMode>[] {
  return APPROVAL_MODES.map((mode) => ({
    value: mode,
    label: APPROVAL_MODE_LABELS[mode],
    disabled: !setting.allowedModes.includes(mode),
  }))
}

/** `project.delete` and any later action that can never run on its own. */
export function actionNote(setting: Pick<ApprovalActionSetting, "allowedModes">): string | null {
  return setting.allowedModes.includes("allow") ? null : "never runs without you"
}

/** Unsaved picks, by action. */
export type ApprovalModeDraft = Partial<Record<AgentActionKind, ApprovalMode>>

/** What the page shows before any pick: the stored mode, else the mode in force. */
export function savedMode(setting: ApprovalActionSetting): ApprovalMode {
  return setting.mode ?? setting.effectiveMode
}

export function shownMode(setting: ApprovalActionSetting, draft: ApprovalModeDraft): ApprovalMode {
  return draft[setting.actionKind] ?? savedMode(setting)
}

/** Only the picks that differ from what the page showed, so Save sends no-ops never. */
export function changedModes(settings: readonly ApprovalActionSetting[], draft: ApprovalModeDraft): ApprovalModeChanges {
  const changes: ApprovalModeChanges = {}
  for (const setting of settings) {
    const picked = draft[setting.actionKind]
    if (picked !== undefined && picked !== savedMode(setting)) changes[setting.actionKind] = picked
  }
  return changes
}

export const ERASE_OPTIONS: ChoiceOption<"erase" | "keep">[] = [
  { value: "erase", label: "Erase" },
  { value: "keep", label: "Keep" },
]

/** The project columns on the approval settings page. */
export type ProjectApprovalFlags = Pick<ProjectApprovalSettings, "eraseBranchAfterPublish" | "requireOtherDecider">

/** Unsaved flag picks. */
export type ProjectFlagDraft = Partial<ProjectApprovalFlags>

/** The value the page shows: the pick, else the saved value. */
export function shownFlags(saved: ProjectApprovalFlags, draft: ProjectFlagDraft): ProjectApprovalFlags {
  return { ...saved, ...draft }
}

/** Only the flags whose pick differs from the saved value. */
export function changedFlags(saved: ProjectApprovalFlags, draft: ProjectFlagDraft): ProjectFlagDraft {
  const changes: ProjectFlagDraft = {}
  if (draft.eraseBranchAfterPublish !== undefined && draft.eraseBranchAfterPublish !== saved.eraseBranchAfterPublish) {
    changes.eraseBranchAfterPublish = draft.eraseBranchAfterPublish
  }
  if (draft.requireOtherDecider !== undefined && draft.requireOtherDecider !== saved.requireOtherDecider) {
    changes.requireOtherDecider = draft.requireOtherDecider
  }
  return changes
}
