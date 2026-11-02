import type { PolicyModeReader } from "../../../repositories/approval-settings";
import type { ActionRegistry } from "../registry";
import { ApprovalPolicyResolver, type ApprovalPolicySource } from "./approval-policy";
import { PlatformOverrideSource } from "./platform-overrides";
import { ProjectSettingSource, UserSettingSource, type GuardedProjectReader } from "./setting-sources";

/**
 * The approval policy sources, in precedence order (spec 8.4, v2 §4):
 * platform overrides, then the project setting, then the user setting. The
 * action default applies when none answers with an allowed mode.
 */
export function approvalPolicySources(
  registry: Pick<ActionRegistry, "rulesFor">,
  modes: PolicyModeReader,
  projects: GuardedProjectReader,
): readonly ApprovalPolicySource[] {
  return [
    new PlatformOverrideSource(),
    new ProjectSettingSource(modes),
    new UserSettingSource(modes, { projects, rulesFor: registry.rulesFor }),
  ];
}

export function approvalPolicyFor(
  registry: Pick<ActionRegistry, "rulesFor">,
  modes: PolicyModeReader,
  projects: GuardedProjectReader,
): ApprovalPolicyResolver {
  return new ApprovalPolicyResolver(approvalPolicySources(registry, modes, projects), registry.rulesFor);
}
