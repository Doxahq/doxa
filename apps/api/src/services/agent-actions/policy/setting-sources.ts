import type { AgentActionKind } from "@doxahq/contracts/approval-requests";
import type { PolicyModeReader } from "../../../repositories/approval-settings";
import type { ActionApprovalRules } from "../action-definition";
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

/**
 * Whether other people rely on a project's approvals: it belongs to a team,
 * or it requires another person to decide.
 */
export interface GuardedProjectReader {
  isGuardedProject(projectId: string): Promise<boolean>;
}

const MODE_STRICTNESS: Record<ApprovalMode, number> = {
  allow: 0,
  require_approval: 1,
  deny: 2,
};

/**
 * The default the user picked for their own agents, in every project.
 *
 * On a guarded project the user setting can only make an action stricter
 * than its default (SEC-012). An editor's own `allow` must not skip the
 * approval that the team relies on; it falls through to the default.
 */
export class UserSettingSource implements ApprovalPolicySource {
  readonly name = USER_SETTING_SOURCE;

  constructor(
    private readonly modes: PolicyModeReader,
    private readonly guard: {
      readonly projects: GuardedProjectReader;
      readonly rulesFor: (action: AgentActionKind) => ActionApprovalRules;
    },
  ) {}

  async modeFor(query: ApprovalPolicyQuery): Promise<ApprovalMode | undefined> {
    const mode = await this.modes.findMode({ kind: "user", userId: query.actor.principal.userId }, query.action);
    if (!mode) return undefined;
    if (query.projectId === null) return mode;

    const defaultMode = this.guard.rulesFor(query.action).defaultMode;
    if (MODE_STRICTNESS[mode] >= MODE_STRICTNESS[defaultMode]) return mode;
    return (await this.guard.projects.isGuardedProject(query.projectId)) ? undefined : mode;
  }
}
