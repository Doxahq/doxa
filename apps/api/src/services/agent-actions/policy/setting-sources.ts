import type { PolicyModeReader } from "../../../repositories/approval-settings";
import type {
  ApprovalMode,
  ApprovalPolicyQuery,
  ApprovalPolicySource,
  ApprovalPolicySourceName,
} from "./approval-policy";

export const PROJECT_SETTING_SOURCE = "project_setting" satisfies ApprovalPolicySourceName;
export const USER_SETTING_SOURCE = "user_setting" satisfies ApprovalPolicySourceName;

/**
 * The mode a project admin picked. It applies to every agent in the
 * project, so it comes before the user setting (spec §4, §12 question 1).
 * `project.create` has no project, so this source never answers for it.
 */
export class ProjectSettingSource implements ApprovalPolicySource {
  readonly name = PROJECT_SETTING_SOURCE;

  constructor(private readonly modes: PolicyModeReader) {}

  async modeFor(query: ApprovalPolicyQuery): Promise<ApprovalMode | undefined> {
    if (query.projectId === null) return undefined;
    const mode = await this.modes.findMode({ kind: "project", projectId: query.projectId }, query.action);
    return mode ?? undefined;
  }
}

/** The default the user picked for their own agents, in every project. */
export class UserSettingSource implements ApprovalPolicySource {
  readonly name = USER_SETTING_SOURCE;

  constructor(private readonly modes: PolicyModeReader) {}

  async modeFor(query: ApprovalPolicyQuery): Promise<ApprovalMode | undefined> {
    const mode = await this.modes.findMode({ kind: "user", userId: query.actor.principal.userId }, query.action);
    return mode ?? undefined;
  }
}
