import { isAgentActionKind } from "@doxahq/contracts/approval-requests";
import type {
  ApprovalActionSetting,
  ApprovalModeChanges,
  ProjectApprovalSettings,
  UpdateProjectApprovalSettingsInput,
  UpdateUserApprovalSettingsInput,
  UserApprovalSettings,
} from "@doxahq/contracts/approval-settings";
import type { AgentActivityStore } from "../../repositories/agent-activity";
import type {
  ApprovalModeChange,
  ApprovalSettingsStore,
  PolicyModeReader,
  PolicyScope,
  ProjectApprovalFlags,
  StoredModes,
} from "../../repositories/approval-settings";
import type { DashboardActor, ProjectId } from "../agent-access/actor";
import type { Capability } from "../agent-access/capabilities";
import type { ActionAccessPolicy } from "./action-access";
import { ActionAccessDeniedError, ApprovalSettingInvalidError } from "./errors";
import type { ApprovalPolicyResolver } from "./policy/approval-policy";
import type { RegisteredAction } from "./registered-action";
import type { ActionRegistry } from "./registry";
import { settingActivity, type ApprovalSettingChange } from "./setting-activity";

export interface ApprovalSettingsServiceDeps {
  readonly registry: ActionRegistry;
  readonly access: ActionAccessPolicy;
  readonly store: ApprovalSettingsStore;
  /** The same sources as the gateway, reading the given stored modes. */
  readonly policyFor: (modes: PolicyModeReader) => Pick<ApprovalPolicyResolver, "resolve">;
  readonly activity: Pick<AgentActivityStore, "append">;
  readonly now: () => Date;
}

/**
 * Spec §4: the approval settings page of a project and of a user. A change
 * applies to new requests only; the cron cancels pending requests of an
 * action set to `deny` (see `ApprovalSweeper.cancelBlocked`).
 */
export class ApprovalSettingsService {
  constructor(private readonly deps: ApprovalSettingsServiceDeps) {}

  async getProject(actor: DashboardActor, rawProjectId: string): Promise<ProjectApprovalSettings> {
    const projectId = await this.authorize(actor, rawProjectId, "project.read");
    const canConfigure = (await this.deps.access.authorize(actor, projectId, "approvals.configure")).allowed;
    return this.projectView(actor, projectId, canConfigure);
  }

  async updateProject(
    actor: DashboardActor,
    rawProjectId: string,
    input: UpdateProjectApprovalSettingsInput,
  ): Promise<ProjectApprovalSettings> {
    const startedAt = this.deps.now().getTime();
    const projectId = await this.authorize(actor, rawProjectId, "approvals.configure");
    const scope: PolicyScope = { kind: "project", projectId };
    const changes = modeChanges(input.modes, this.projectActions());
    const replaced = await this.deps.store.applyModes(scope, changes, actor.principal.userId, this.deps.now());
    const recorded = modeActivityChanges(scope, changes, replaced);
    recorded.push(...(await this.applyFlags(projectId, input)));
    await this.record(actor, projectId, recorded, startedAt);
    return this.projectView(actor, projectId, true);
  }

  /** Sets the project columns in one write and returns the changes that altered a value. */
  private async applyFlags(
    projectId: ProjectId,
    input: UpdateProjectApprovalSettingsInput,
  ): Promise<ApprovalSettingChange[]> {
    const changes: Partial<ProjectApprovalFlags> = {
      ...(input.eraseBranchAfterPublish === undefined ? {} : { eraseBranchAfterPublish: input.eraseBranchAfterPublish }),
      ...(input.requireOtherDecider === undefined ? {} : { requireOtherDecider: input.requireOtherDecider }),
    };
    if (Object.keys(changes).length === 0) return [];
    const previous = await this.deps.store.setProjectFlags(projectId, changes);
    if (previous === null) return [];
    const recorded: ApprovalSettingChange[] = [];
    if (changes.eraseBranchAfterPublish !== undefined && previous.eraseBranchAfterPublish !== changes.eraseBranchAfterPublish) {
      recorded.push({ kind: "erase_branch_after_publish", from: previous.eraseBranchAfterPublish, to: changes.eraseBranchAfterPublish });
    }
    if (changes.requireOtherDecider !== undefined && previous.requireOtherDecider !== changes.requireOtherDecider) {
      recorded.push({ kind: "require_other_decider", from: previous.requireOtherDecider, to: changes.requireOtherDecider });
    }
    return recorded;
  }

  getUser(actor: DashboardActor): Promise<UserApprovalSettings> {
    return this.userView(actor);
  }

  async updateUser(actor: DashboardActor, input: UpdateUserApprovalSettingsInput): Promise<UserApprovalSettings> {
    const startedAt = this.deps.now().getTime();
    const scope: PolicyScope = { kind: "user", userId: actor.principal.userId };
    const changes = modeChanges(input.modes, this.allActions());
    const replaced = await this.deps.store.applyModes(scope, changes, actor.principal.userId, this.deps.now());
    await this.record(actor, null, modeActivityChanges(scope, changes, replaced), startedAt);
    return this.userView(actor);
  }

  private async authorize(actor: DashboardActor, projectId: string, capability: Capability): Promise<ProjectId> {
    const decision = await this.deps.access.authorize(actor, projectId, capability);
    if (!decision.allowed) throw new ActionAccessDeniedError(decision.reason);
    return decision.project.projectId;
  }

  /** `project.create` has no project, so a project cannot set it. */
  private projectActions(): RegisteredAction[] {
    return this.allActions().filter((action) => action.targetKind === "project");
  }

  private allActions(): RegisteredAction[] {
    return this.deps.registry.kinds.map((kind) => this.deps.registry.get(kind));
  }

  private async projectView(
    actor: DashboardActor,
    projectId: ProjectId,
    canConfigure: boolean,
  ): Promise<ProjectApprovalSettings> {
    const projectScope: PolicyScope = { kind: "project", projectId };
    const userScope: PolicyScope = { kind: "user", userId: actor.principal.userId };
    const [projectModes, userModes, flags] = await Promise.all([
      this.deps.store.listModes(projectScope),
      this.deps.store.listModes(userScope),
      this.deps.store.projectFlags(projectId),
    ]);
    if (flags === null) throw new ActionAccessDeniedError("not_found");
    const resolver = this.deps.policyFor(
      preloadedModes([
        { scope: projectScope, modes: projectModes },
        { scope: userScope, modes: userModes },
      ]),
    );
    const actions = await Promise.all(
      this.projectActions().map((action) => actionSetting(action, projectModes, resolver, actor, projectId)),
    );
    return {
      projectId,
      canConfigure,
      actions,
      eraseBranchAfterPublish: flags.eraseBranchAfterPublish,
      requireOtherDecider: flags.requireOtherDecider,
    };
  }

  private async userView(actor: DashboardActor): Promise<UserApprovalSettings> {
    const userScope: PolicyScope = { kind: "user", userId: actor.principal.userId };
    const userModes = await this.deps.store.listModes(userScope);
    const resolver = this.deps.policyFor(preloadedModes([{ scope: userScope, modes: userModes }]));
    const actions = await Promise.all(
      this.allActions().map((action) => actionSetting(action, userModes, resolver, actor, null)),
    );
    return { actions };
  }

  /** One activity row for each change that altered a value. */
  private async record(
    actor: DashboardActor,
    projectId: string | null,
    changes: readonly ApprovalSettingChange[],
    startedAt: number,
  ): Promise<void> {
    const durationMs = this.deps.now().getTime() - startedAt;
    await Promise.all(
      changes.map((change) =>
        this.deps.activity.append(settingActivity({ userId: actor.principal.userId, projectId, change, durationMs })),
      ),
    );
  }
}

async function actionSetting(
  action: RegisteredAction,
  stored: StoredModes,
  resolver: Pick<ApprovalPolicyResolver, "resolve">,
  actor: DashboardActor,
  projectId: ProjectId | null,
): Promise<ApprovalActionSetting> {
  const effective = await resolver.resolve({ actor, projectId, action: action.kind });
  const mode = stored.get(action.kind) ?? null;
  return {
    actionKind: action.kind,
    title: action.title,
    allowedModes: [...action.approval.allowedModes],
    defaultMode: action.approval.defaultMode,
    // A stored mode outside allowedModes is ignored, so it reads as not set.
    mode: mode !== null && action.approval.allowedModes.includes(mode) ? mode : null,
    effectiveMode: effective.mode,
    effectiveSource: effective.source,
  };
}

/** Validates the input against the actions this scope can set. */
function modeChanges(
  input: ApprovalModeChanges | undefined,
  settable: readonly RegisteredAction[],
): ApprovalModeChange[] {
  const byKind = new Map(settable.map((action) => [action.kind, action]));
  return Object.entries(input ?? {}).map(([actionKind, mode]) => {
    const action = isAgentActionKind(actionKind) ? byKind.get(actionKind) : undefined;
    if (action === undefined) throw new ApprovalSettingInvalidError(`${actionKind} cannot be set here.`);
    if (mode === undefined || mode === null) return { actionKind, mode: null };
    if (!action.approval.allowedModes.includes(mode)) {
      throw new ApprovalSettingInvalidError(`${actionKind} does not allow the mode ${mode}.`);
    }
    return { actionKind, mode };
  });
}

function modeActivityChanges(
  scope: PolicyScope,
  changes: readonly ApprovalModeChange[],
  replaced: StoredModes,
): ApprovalSettingChange[] {
  return changes
    .map((change) => ({
      kind: "approval_mode" as const,
      scope: scope.kind,
      actionKind: change.actionKind,
      from: replaced.get(change.actionKind) ?? null,
      to: change.mode,
    }))
    .filter((change) => change.from !== change.to);
}

/** Answers from modes already loaded, so one page view costs one query per scope. */
function preloadedModes(loaded: readonly { scope: PolicyScope; modes: StoredModes }[]): PolicyModeReader {
  return {
    findMode: async (scope, actionKind) =>
      loaded.find((entry) => sameScope(entry.scope, scope))?.modes.get(actionKind) ?? null,
  };
}

function sameScope(a: PolicyScope, b: PolicyScope): boolean {
  if (a.kind === "project") return b.kind === "project" && a.projectId === b.projectId;
  return b.kind === "user" && a.userId === b.userId;
}
