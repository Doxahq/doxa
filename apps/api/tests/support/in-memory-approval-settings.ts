import type { ApprovalMode } from "@doxahq/contracts/approval-settings";
import type {
  ApprovalModeChange,
  ApprovalSettingsStore,
  PolicyScope,
  ProjectApprovalFlags,
  StoredModes,
} from "../../src/repositories/approval-settings";

/** Same semantics as the Drizzle store: one row for each scope and action. */
export class InMemoryApprovalSettingsStore implements ApprovalSettingsStore {
  readonly modes = new Map<string, ApprovalMode>();
  readonly flags = new Map<string, ProjectApprovalFlags>();
  /** Projects that belong to a team. */
  readonly teamProjects = new Set<string>();

  /** Projects that exist, with the column defaults. */
  constructor(projectIds: readonly string[] = []) {
    for (const projectId of projectIds) {
      this.flags.set(projectId, { eraseBranchAfterPublish: true, requireOtherDecider: false });
    }
  }

  async findMode(scope: PolicyScope, actionKind: string): Promise<ApprovalMode | null> {
    return this.modes.get(rowKey(scope, actionKind)) ?? null;
  }

  async listModes(scope: PolicyScope): Promise<StoredModes> {
    const prefix = rowKey(scope, "");
    return new Map(
      [...this.modes].filter(([key]) => key.startsWith(prefix)).map(([key, mode]) => [key.slice(prefix.length), mode]),
    );
  }

  async applyModes(scope: PolicyScope, changes: readonly ApprovalModeChange[]): Promise<StoredModes> {
    const previous = new Map<string, ApprovalMode>();
    for (const change of changes) {
      const key = rowKey(scope, change.actionKind);
      const old = this.modes.get(key);
      if (old !== undefined) previous.set(change.actionKind, old);
      if (change.mode === null) this.modes.delete(key);
      else this.modes.set(key, change.mode);
    }
    return previous;
  }

  async isGuardedProject(projectId: string): Promise<boolean> {
    return this.teamProjects.has(projectId) || this.flags.get(projectId)?.requireOtherDecider === true;
  }

  async projectFlags(projectId: string): Promise<ProjectApprovalFlags | null> {
    return this.flags.get(projectId) ?? null;
  }

  async setProjectFlags(projectId: string, changes: Partial<ProjectApprovalFlags>): Promise<ProjectApprovalFlags | null> {
    const previous = this.flags.get(projectId);
    if (previous === undefined) return null;
    this.flags.set(projectId, { ...previous, ...changes });
    return previous;
  }

  /** Test helper: stores a mode as-is, even one outside allowedModes. */
  seed(scope: PolicyScope, actionKind: string, mode: ApprovalMode): void {
    this.modes.set(rowKey(scope, actionKind), mode);
  }
}

function rowKey(scope: PolicyScope, actionKind: string): string {
  const id = scope.kind === "project" ? scope.projectId : scope.userId;
  return `${scope.kind}:${id}:${actionKind}`;
}
