import type { SourceProvider } from "@doxahq/contracts";
import { createDb, schema, type DbEnv } from "@doxahq/db";
import { and, eq } from "drizzle-orm";

export type ChangeProposalLifecycleState = "open" | "closed" | "merged";

export interface ChangeProposalRecord {
  id: string;
  projectId: string;
  provider: SourceProvider;
  repositoryExternalId: string;
  installationExternalId: string;
  externalId: string;
  displayNumber: number;
  draft: boolean;
  state: ChangeProposalLifecycleState;
  defaultBranch: string;
  baseRef: string;
  baseRevision: string;
  headRevision: string;
  sourceUpdatedAt: Date;
  lastSourceTreeHash: string | null;
}

export interface EnsureChangeProposalInput {
  projectId: string;
  provider: SourceProvider;
  repositoryExternalId: string;
  installationExternalId: string;
  externalId: string;
  displayNumber: number;
  draft: boolean;
  state: ChangeProposalLifecycleState;
  defaultBranch: string;
  baseRef: string;
  baseRevision: string;
  headRevision: string;
  sourceUpdatedAt: Date;
}

export interface EnsuredChangeProposal {
  outcome: "created" | "existing";
  proposal: ChangeProposalRecord;
}

export interface ChangeProposalsStore {
  ensure(input: EnsureChangeProposalInput): Promise<EnsuredChangeProposal>;
  getByIdentity(input: {
    projectId: string;
    provider: SourceProvider;
    externalId: string;
  }): Promise<ChangeProposalRecord | null>;
  compareAndSetHead(input: {
    proposalId: string;
    expectedHeadRevision: string;
    expectedSourceUpdatedAt: Date;
    headRevision: string;
    baseRevision: string;
    defaultBranch: string;
    baseRef: string;
    installationExternalId: string;
    draft: boolean;
    state: ChangeProposalLifecycleState;
    sourceUpdatedAt: Date;
  }): Promise<ChangeProposalRecord | null>;
  recordSourceTreeHash(input: {
    proposalId: string;
    headRevision: string;
    sourceTreeHash: string;
  }): Promise<boolean>;
}

export class ChangeProposalsRepository implements ChangeProposalsStore {
  private readonly db;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  async ensure(
    input: EnsureChangeProposalInput,
  ): Promise<EnsuredChangeProposal> {
    const [created] = await this.db
      .insert(schema.scmChangeProposals)
      .values(input)
      .onConflictDoNothing({
        target: [
          schema.scmChangeProposals.projectId,
          schema.scmChangeProposals.provider,
          schema.scmChangeProposals.externalId,
        ],
      })
      .returning();

    if (created) {
      return { outcome: "created", proposal: toRecord(created) };
    }

    const existing = await this.getByIdentity(input);
    if (!existing) {
      throw new Error("Change proposal could not be created or resolved.");
    }
    return { outcome: "existing", proposal: existing };
  }

  async getByIdentity(input: {
    projectId: string;
    provider: SourceProvider;
    externalId: string;
  }): Promise<ChangeProposalRecord | null> {
    const [row] = await this.db
      .select()
      .from(schema.scmChangeProposals)
      .where(
        and(
          eq(schema.scmChangeProposals.projectId, input.projectId),
          eq(schema.scmChangeProposals.provider, input.provider),
          eq(schema.scmChangeProposals.externalId, input.externalId),
        ),
      )
      .limit(1);

    return row ? toRecord(row) : null;
  }

  async compareAndSetHead(input: {
    proposalId: string;
    expectedHeadRevision: string;
    expectedSourceUpdatedAt: Date;
    headRevision: string;
    baseRevision: string;
    defaultBranch: string;
    baseRef: string;
    installationExternalId: string;
    draft: boolean;
    state: ChangeProposalLifecycleState;
    sourceUpdatedAt: Date;
  }): Promise<ChangeProposalRecord | null> {
    const [updated] = await this.db
      .update(schema.scmChangeProposals)
      .set({
        headRevision: input.headRevision,
        baseRevision: input.baseRevision,
        defaultBranch: input.defaultBranch,
        baseRef: input.baseRef,
        installationExternalId: input.installationExternalId,
        draft: input.draft,
        state: input.state,
        sourceUpdatedAt: input.sourceUpdatedAt,
        lastSourceTreeHash:
          input.headRevision === input.expectedHeadRevision
            ? undefined
            : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.scmChangeProposals.id, input.proposalId),
          eq(
            schema.scmChangeProposals.headRevision,
            input.expectedHeadRevision,
          ),
          eq(
            schema.scmChangeProposals.sourceUpdatedAt,
            input.expectedSourceUpdatedAt,
          ),
        ),
      )
      .returning();

    return updated ? toRecord(updated) : null;
  }

  async recordSourceTreeHash(input: {
    proposalId: string;
    headRevision: string;
    sourceTreeHash: string;
  }): Promise<boolean> {
    const [updated] = await this.db
      .update(schema.scmChangeProposals)
      .set({
        lastSourceTreeHash: input.sourceTreeHash,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.scmChangeProposals.id, input.proposalId),
          eq(schema.scmChangeProposals.headRevision, input.headRevision),
        ),
      )
      .returning({ id: schema.scmChangeProposals.id });

    return Boolean(updated);
  }
}

function toRecord(
  row: typeof schema.scmChangeProposals.$inferSelect,
): ChangeProposalRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    provider: row.provider,
    repositoryExternalId: row.repositoryExternalId,
    installationExternalId: row.installationExternalId,
    externalId: row.externalId,
    displayNumber: row.displayNumber,
    draft: row.draft,
    state: row.state,
    defaultBranch: row.defaultBranch,
    baseRef: row.baseRef,
    baseRevision: row.baseRevision,
    headRevision: row.headRevision,
    sourceUpdatedAt: row.sourceUpdatedAt,
    lastSourceTreeHash: row.lastSourceTreeHash,
  };
}
