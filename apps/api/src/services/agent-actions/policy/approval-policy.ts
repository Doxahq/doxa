import type { AgentActionKind } from "@doxahq/contracts/approval-requests";
import type { ApprovalMode, ApprovalPolicySourceName } from "@doxahq/contracts/approval-settings";
import type { Actor, ProjectId } from "../../agent-access/actor";
import type { ActionApprovalRules } from "../action-definition";

export type { ApprovalMode, ApprovalPolicySourceName };

export interface ApprovalPolicyQuery {
  /**
   * The user whose agent asks. The dashboard and the cron resolve for a
   * user too, to show the effective mode and to cancel blocked requests.
   */
  readonly actor: Actor;
  /** Null only for `project.create`. */
  readonly projectId: ProjectId | null;
  readonly action: AgentActionKind;
}

/** One input to the policy: a platform override, a project or a user setting. */
export interface ApprovalPolicySource {
  readonly name: ApprovalPolicySourceName;
  modeFor(query: ApprovalPolicyQuery): Promise<ApprovalMode | undefined>;
}

export interface ResolvedApprovalMode {
  readonly mode: ApprovalMode;
  /** Goes on the request row and in the activity log: why a gate applied. */
  readonly source: ApprovalPolicySourceName;
}

export interface IgnoredModeEvent {
  readonly source: ApprovalPolicySourceName;
  readonly action: AgentActionKind;
  readonly mode: ApprovalMode;
}

export const ACTION_DEFAULT_SOURCE = "action_default" satisfies ApprovalPolicySourceName;

/**
 * Spec 8.4. The first source that answers with a mode inside the action's
 * `allowedModes` wins; otherwise the action default applies. A mode outside
 * `allowedModes` is ignored, so no source can lift `project.delete` to
 * `allow`.
 */
export class ApprovalPolicyResolver {
  constructor(
    private readonly sources: readonly ApprovalPolicySource[],
    private readonly rulesFor: (action: AgentActionKind) => ActionApprovalRules,
    private readonly onIgnoredMode: (event: IgnoredModeEvent) => void = logIgnoredMode,
  ) {}

  async resolve(query: ApprovalPolicyQuery): Promise<ResolvedApprovalMode> {
    const rules = this.rulesFor(query.action);
    for (const source of this.sources) {
      const mode = await source.modeFor(query);
      if (mode === undefined) continue;
      if (rules.allowedModes.includes(mode)) return { mode, source: source.name };
      this.onIgnoredMode({ source: source.name, action: query.action, mode });
    }
    return { mode: rules.defaultMode, source: ACTION_DEFAULT_SOURCE };
  }
}

function logIgnoredMode(event: IgnoredModeEvent): void {
  console.warn(JSON.stringify({ message: "approval_mode_ignored", ...event }));
}
