import type { PolicyModeReader } from "../../../repositories/approval-settings";
import type { ActionRegistry } from "../registry";
import { ApprovalPolicyResolver, type ApprovalPolicySource } from "./approval-policy";
import { PlatformOverrideSource } from "./platform-overrides";
import { ProjectSettingSource, UserSettingSource } from "./setting-sources";

/**
 * The approval policy sources, in precedence order (spec 8.4, v2 §4):
 * platform overrides, then the project setting, then the user setting. The
 * action default applies when none answers with an allowed mode.
 */
export function approvalPolicySources(modes: PolicyModeReader): readonly ApprovalPolicySource[] {
  return [new PlatformOverrideSource(), new ProjectSettingSource(modes), new UserSettingSource(modes)];
}

export function approvalPolicyFor(
  registry: Pick<ActionRegistry, "rulesFor">,
  modes: PolicyModeReader,
): ApprovalPolicyResolver {
  return new ApprovalPolicyResolver(approvalPolicySources(modes), registry.rulesFor);
}
