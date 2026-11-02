import { and, eq, inArray, type SQL } from "drizzle-orm";
import { createDb, schema, type DbEnv, type DoxaDb } from "@doxahq/db";
import type { ApprovalMode } from "@doxahq/contracts/approval-settings";

/** Who a stored approval mode applies to. */
export type PolicyScope =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "user"; readonly userId: string };

/** The stored modes of one scope, by action kind. Kinds a release removed stay in. */
export type StoredModes = ReadonlyMap<string, ApprovalMode>;

/** Reads one stored mode. The policy sources need only this. */
export interface PolicyModeReader {
  findMode(scope: PolicyScope, actionKind: string): Promise<ApprovalMode | null>;
}

export interface ApprovalModeChange {
  readonly actionKind: string;
  /** Null deletes the row: the action falls through to the next source. */
  readonly mode: ApprovalMode | null;
}

export interface ApprovalSettingsStore extends PolicyModeReader {
  listModes(scope: PolicyScope): Promise<StoredModes>;
  /** Applies every change in one transaction and returns the modes it replaced. */
  applyModes(
    scope: PolicyScope,
    changes: readonly ApprovalModeChange[],
    updatedByUserId: string,
    now: Date,
  ): Promise<StoredModes>;
  /** Null when the project does not exist. */
  projectFlags(projectId: string): Promise<ProjectApprovalFlags | null>;
  /** Returns the values it replaced, or null when the project does not exist. */
  setProjectFlags(projectId: string, changes: Partial<ProjectApprovalFlags>): Promise<ProjectApprovalFlags | null>;
}

/** The approval settings that are columns on `projects`. */
export interface ProjectApprovalFlags {
  /** The default of the erase checkbox when a person approves a publish. */
  readonly eraseBranchAfterPublish: boolean;
  /** v2 spec §12 question 2: the requester cannot approve their own agent's request. */
  readonly requireOtherDecider: boolean;
}

const flagColumns = {
  eraseBranchAfterPublish: schema.projects.eraseBranchAfterPublish,
  requireOtherDecider: schema.projects.requireOtherDecider,
};

const table = schema.agentActionPolicies;

type Tx = Parameters<Parameters<DoxaDb["transaction"]>[0]>[0];

export class ApprovalSettingsRepository implements ApprovalSettingsStore {
  private readonly db: DoxaDb;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  async findMode(scope: PolicyScope, actionKind: string): Promise<ApprovalMode | null> {
    const [row] = await this.db
      .select({ mode: table.mode })
      .from(table)
      .where(and(scopeCondition(scope), eq(table.actionKind, actionKind)))
      .limit(1);
    return row?.mode ?? null;
  }

  async listModes(scope: PolicyScope): Promise<StoredModes> {
    const rows = await this.db
      .select({ actionKind: table.actionKind, mode: table.mode })
      .from(table)
      .where(scopeCondition(scope));
    return toModes(rows);
  }

  applyModes(
    scope: PolicyScope,
    changes: readonly ApprovalModeChange[],
    updatedByUserId: string,
    now: Date,
  ): Promise<StoredModes> {
    if (changes.length === 0) return Promise.resolve(new Map());
    return this.db.transaction(async (tx) => {
      const previous = await lockModes(tx, scope, changes.map((change) => change.actionKind));
      for (const change of changes) {
        if (change.mode === null) {
          await tx.delete(table).where(and(scopeCondition(scope), eq(table.actionKind, change.actionKind)));
        } else {
          await upsertMode(tx, scope, { ...change, mode: change.mode }, updatedByUserId, now);
        }
      }
      return previous;
    });
  }

  /** A team project, or one that requires another decider (SEC-012). */
  async isGuardedProject(projectId: string): Promise<boolean> {
    const [row] = await this.db
      .select({
        teamId: schema.projects.teamId,
        requireOtherDecider: schema.projects.requireOtherDecider,
      })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .limit(1);
    return row !== undefined && (row.teamId !== null || row.requireOtherDecider);
  }

  async projectFlags(projectId: string): Promise<ProjectApprovalFlags | null> {
    const [row] = await this.db
      .select(flagColumns)
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .limit(1);
    return row ?? null;
  }

  setProjectFlags(projectId: string, changes: Partial<ProjectApprovalFlags>): Promise<ProjectApprovalFlags | null> {
    return this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select(flagColumns)
        .from(schema.projects)
        .where(eq(schema.projects.id, projectId))
        .for("update")
        .limit(1);
      if (!locked) return null;
      await tx
        .update(schema.projects)
        .set({ ...changes, updatedAt: new Date() })
        .where(eq(schema.projects.id, projectId));
      return locked;
    });
  }
}

async function lockModes(tx: Tx, scope: PolicyScope, actionKinds: readonly string[]): Promise<StoredModes> {
  const rows = await tx
    .select({ actionKind: table.actionKind, mode: table.mode })
    .from(table)
    .where(and(scopeCondition(scope), inArray(table.actionKind, [...actionKinds])))
    .for("update");
  return toModes(rows);
}

async function upsertMode(
  tx: Tx,
  scope: PolicyScope,
  change: { actionKind: string; mode: ApprovalMode },
  updatedByUserId: string,
  now: Date,
): Promise<void> {
  const columns = { mode: change.mode, updatedByUserId, updatedAt: now };
  const insert = tx.insert(table);
  if (scope.kind === "project") {
    await insert
      .values({ scopeKind: "project", projectId: scope.projectId, actionKind: change.actionKind, ...columns })
      .onConflictDoUpdate({ target: [table.projectId, table.actionKind], set: columns });
    return;
  }
  await insert
    .values({ scopeKind: "user", userId: scope.userId, actionKind: change.actionKind, ...columns })
    .onConflictDoUpdate({ target: [table.userId, table.actionKind], set: columns });
}

function scopeCondition(scope: PolicyScope): SQL | undefined {
  return scope.kind === "project"
    ? and(eq(table.scopeKind, "project"), eq(table.projectId, scope.projectId))
    : and(eq(table.scopeKind, "user"), eq(table.userId, scope.userId));
}

function toModes(rows: readonly { actionKind: string; mode: ApprovalMode }[]): StoredModes {
  return new Map(rows.map((row) => [row.actionKind, row.mode]));
}
