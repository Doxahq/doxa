import { and, count, desc, eq, ne, sql } from "drizzle-orm";

import type {
  CreateDocsBranchInput,
  DocsBranchCreator,
  RenameDocsBranchInput,
} from "@doxahq/contracts/docs-branches";
import { schema, type DoxaDb } from "@doxahq/db";

import {
  DOCS_PUBLISH_ACTION_KIND,
  publishTargetKey,
} from "../services/agent-actions/actions/publish-target";
import {
  creatorColumns,
  toStoredBranch,
  type StoredNamedDocsBranch,
} from "./docs-branch-records";
import { retireBranchPreview } from "./docs-branch-preview-gc";
import { discardReviewOfBranch } from "./generation-review-records";

export interface NamedBranchRecord {
  branch: StoredNamedDocsBranch;
  changeCount: number;
}

export type CreateNamedBranchResult =
  | { status: "created"; record: NamedBranchRecord }
  | { status: "limit_reached"; used: number }
  | { status: "not_found" | "name_taken" };

export type RenameNamedBranchResult =
  | { status: "renamed"; record: NamedBranchRecord }
  | { status: "not_found" | "name_taken" };

/**
 * `collectEntryIds` names the storage entries to collect after the commit.
 * `publish_pending`: an agent asked to delete a branch that waits for a
 * publish decision.
 */
export type EraseNamedBranchResult =
  | { status: "erased"; collectEntryIds: string[] }
  | { status: "not_found" }
  | { status: "publish_pending"; requestId: string };

/**
 * An agent as its branches record it: the OAuth client and the member it
 * acts for. Two members can share a client ID, so both must match.
 */
export interface BranchAgentIdentity {
  clientId: string;
  userId: string;
}

/**
 * Who erases the branch. A user erases any branch they own. An agent erases
 * only a branch that the same client created for the same member, and never
 * one with a pending publish request.
 */
export type BranchEraser =
  | { kind: "user" }
  | ({ kind: "agent" } & BranchAgentIdentity);

export interface DocsBranchManagementStore {
  listNamedBranches(
    input: BranchOwnerInput,
  ): Promise<NamedBranchRecord[] | null>;
  createNamedBranch(
    input: BranchOwnerInput & {
      request: CreateDocsBranchInput;
      createdBy: DocsBranchCreator;
      maxBranches: number;
    },
  ): Promise<CreateNamedBranchResult>;
  renameNamedBranch(
    input: BranchOwnerInput & {
      branchId: string;
      request: RenameDocsBranchInput;
    },
  ): Promise<RenameNamedBranchResult>;
  eraseNamedBranch(
    input: BranchOwnerInput & { branchId: string; eraser: BranchEraser },
  ): Promise<EraseNamedBranchResult>;
}

interface BranchOwnerInput {
  userId: string;
  projectId: string;
}

interface OwnedSite {
  id: string;
  publishedVersionId: string;
}

type SelectDatabase = Pick<DoxaDb, "select">;

export async function listNamedBranches(
  db: DoxaDb,
  input: BranchOwnerInput,
): Promise<NamedBranchRecord[] | null> {
  const site = await findOwnedSite(db, input);

  if (!site) {
    return null;
  }

  const rows = await db
    .select({
      branch: schema.docsBranches,
      changeCount: count(schema.docsBranchChanges.path),
    })
    .from(schema.docsBranches)
    .leftJoin(
      schema.docsBranchChanges,
      eq(schema.docsBranchChanges.branchId, schema.docsBranches.id),
    )
    .where(
      and(
        eq(schema.docsBranches.siteId, site.id),
        eq(schema.docsBranches.ownerUserId, input.userId),
        eq(schema.docsBranches.kind, "named"),
      ),
    )
    .groupBy(schema.docsBranches.id)
    .orderBy(desc(schema.docsBranches.updatedAt), desc(schema.docsBranches.id));

  return rows.map(({ branch, changeCount }) => ({
    branch: toNamedBranch(branch),
    changeCount,
  }));
}

export async function createNamedBranch(
  db: DoxaDb,
  input: BranchOwnerInput & {
    request: CreateDocsBranchInput;
    createdBy: DocsBranchCreator;
    maxBranches: number;
  },
): Promise<CreateNamedBranchResult> {
  return db.transaction(async (tx) => {
    const site = await lockOwnedSite(tx, input);

    if (!site) {
      return { status: "not_found" };
    }

    const source =
      input.request.from.kind === "branch"
        ? await lockSourceBranch(tx, {
            siteId: site.id,
            userId: input.userId,
            branchId: input.request.from.branchId,
          })
        : null;

    if (input.request.from.kind === "branch" && !source) {
      return { status: "not_found" };
    }

    // Review and backup branches belong to generation, not to the plan limit.
    const [branchCount] = await tx
      .select({ value: count() })
      .from(schema.docsBranches)
      .where(
        and(
          eq(schema.docsBranches.siteId, site.id),
          eq(schema.docsBranches.kind, "named"),
          eq(schema.docsBranches.purpose, "user"),
        ),
      );

    if ((branchCount?.value ?? 0) >= input.maxBranches) {
      return { status: "limit_reached", used: branchCount?.value ?? 0 };
    }

    if (await isBranchNameTaken(tx, site.id, input.request.name)) {
      return { status: "name_taken" };
    }

    const [created] = await tx
      .insert(schema.docsBranches)
      .values({
        siteId: site.id,
        kind: "named",
        name: input.request.name,
        ownerUserId: input.userId,
        baseVersionId: source?.baseVersionId ?? site.publishedVersionId,
        createdFromBranchId: source?.id ?? null,
        ...creatorColumns(input.createdBy),
      })
      .returning();

    if (!created) {
      throw new Error("Named branch insert returned no row");
    }

    if (source) {
      await tx.insert(schema.docsBranchChanges).select(
        tx
          .select({
            branchId: sql<string>`${created.id}`.as("branch_id"),
            path: schema.docsBranchChanges.path,
            kind: schema.docsBranchChanges.kind,
            content: schema.docsBranchChanges.content,
            contentSha256: schema.docsBranchChanges.contentSha256,
            byteSize: schema.docsBranchChanges.byteSize,
            updatedByUserId: schema.docsBranchChanges.updatedByUserId,
            origin: schema.docsBranchChanges.origin,
            updatedAt: schema.docsBranchChanges.updatedAt,
          })
          .from(schema.docsBranchChanges)
          .where(eq(schema.docsBranchChanges.branchId, source.id)),
      );
    }

    return {
      status: "created",
      record: {
        branch: toNamedBranch(created),
        changeCount: source ? await countBranchChanges(tx, created.id) : 0,
      },
    };
  });
}

export async function renameNamedBranch(
  db: DoxaDb,
  input: BranchOwnerInput & {
    branchId: string;
    request: RenameDocsBranchInput;
  },
): Promise<RenameNamedBranchResult> {
  return db.transaction(async (tx) => {
    const site = await lockOwnedSite(tx, input);

    if (!site) {
      return { status: "not_found" };
    }

    const [branch] = await tx
      .select()
      .from(schema.docsBranches)
      .where(
        and(
          eq(schema.docsBranches.id, input.branchId),
          eq(schema.docsBranches.siteId, site.id),
          eq(schema.docsBranches.ownerUserId, input.userId),
          eq(schema.docsBranches.kind, "named"),
        ),
      )
      .for("update")
      .limit(1);

    if (!branch) {
      return { status: "not_found" };
    }

    if (await isBranchNameTaken(tx, site.id, input.request.name, branch.id)) {
      return { status: "name_taken" };
    }

    const [renamed] = await tx
      .update(schema.docsBranches)
      .set({ name: input.request.name, updatedAt: new Date() })
      .where(eq(schema.docsBranches.id, branch.id))
      .returning();

    if (!renamed) {
      throw new Error("Named branch update returned no row");
    }

    return {
      status: "renamed",
      record: {
        branch: toNamedBranch(renamed),
        changeCount: await countBranchChanges(tx, renamed.id),
      },
    };
  });
}

export async function eraseNamedBranch(
  db: DoxaDb,
  input: BranchOwnerInput & { branchId: string; eraser: BranchEraser },
): Promise<EraseNamedBranchResult> {
  return db.transaction(async (tx) => {
    const site = await lockOwnedSite(tx, input);

    if (!site) {
      return { status: "not_found" };
    }

    const [branch] = await tx
      .select({ id: schema.docsBranches.id })
      .from(schema.docsBranches)
      .where(
        and(
          eq(schema.docsBranches.id, input.branchId),
          eq(schema.docsBranches.siteId, site.id),
          eq(schema.docsBranches.ownerUserId, input.userId),
          eq(schema.docsBranches.kind, "named"),
          input.eraser.kind === "agent"
            ? and(
                eq(schema.docsBranches.createdByClientId, input.eraser.clientId),
                eq(schema.docsBranches.createdByUserId, input.eraser.userId),
              )
            : undefined,
        ),
      )
      .for("update")
      .limit(1);

    if (!branch) {
      return { status: "not_found" };
    }

    if (input.eraser.kind === "agent") {
      const pending = await findPendingPublishRequest(tx, {
        projectId: input.projectId,
        branchId: branch.id,
      });

      if (pending) {
        return { status: "publish_pending", requestId: pending.id };
      }
    }

    const collectEntryIds = await retireBranchPreview(tx, {
      branchId: branch.id,
      siteId: site.id,
    });
    await discardReviewOfBranch(tx, {
      branchId: branch.id,
      actorUserId: input.userId,
    });
    await tx
      .delete(schema.docsBranches)
      .where(eq(schema.docsBranches.id, branch.id));

    return { status: "erased", collectEntryIds };
  });
}

async function findPendingPublishRequest(
  db: SelectDatabase,
  input: { projectId: string; branchId: string },
): Promise<{ id: string } | null> {
  const requests = schema.agentApprovalRequests;
  const [request] = await db
    .select({ id: requests.id })
    .from(requests)
    .where(
      and(
        eq(requests.projectId, input.projectId),
        eq(requests.actionKind, DOCS_PUBLISH_ACTION_KIND),
        eq(requests.targetKey, publishTargetKey(input.branchId)),
        eq(requests.status, "pending"),
      ),
    )
    .limit(1);

  return request ?? null;
}

async function findOwnedSite(
  db: SelectDatabase,
  input: BranchOwnerInput,
): Promise<OwnedSite | null> {
  const [site] = await db
    .select({
      id: schema.docsSites.id,
      publishedVersionId: schema.docsSites.publishedVersionId,
    })
    .from(schema.projects)
    .innerJoin(
      schema.docsSites,
      eq(schema.docsSites.projectId, schema.projects.id),
    )
    .where(
      and(
        eq(schema.projects.id, input.projectId),
        eq(schema.projects.userId, input.userId),
      ),
    )
    .limit(1);

  return site?.publishedVersionId
    ? { id: site.id, publishedVersionId: site.publishedVersionId }
    : null;
}

async function lockOwnedSite(
  db: SelectDatabase,
  input: BranchOwnerInput,
): Promise<OwnedSite | null> {
  const owned = await findOwnedSite(db, input);

  if (!owned) {
    return null;
  }

  const [site] = await db
    .select({
      id: schema.docsSites.id,
      publishedVersionId: schema.docsSites.publishedVersionId,
    })
    .from(schema.docsSites)
    .where(eq(schema.docsSites.id, owned.id))
    .for("update")
    .limit(1);

  return site?.publishedVersionId
    ? { id: site.id, publishedVersionId: site.publishedVersionId }
    : null;
}

async function lockSourceBranch(
  db: SelectDatabase,
  input: { siteId: string; userId: string; branchId: string },
) {
  const [branch] = await db
    .select()
    .from(schema.docsBranches)
    .where(
      and(
        eq(schema.docsBranches.id, input.branchId),
        eq(schema.docsBranches.siteId, input.siteId),
        eq(schema.docsBranches.ownerUserId, input.userId),
        eq(schema.docsBranches.kind, "named"),
      ),
    )
    .for("update")
    .limit(1);

  return branch ?? null;
}

async function isBranchNameTaken(
  db: SelectDatabase,
  siteId: string,
  name: string,
  excludedBranchId?: string,
): Promise<boolean> {
  const [branch] = await db
    .select({ id: schema.docsBranches.id })
    .from(schema.docsBranches)
    .where(
      and(
        eq(schema.docsBranches.siteId, siteId),
        eq(schema.docsBranches.kind, "named"),
        eq(schema.docsBranches.name, name),
        excludedBranchId
          ? ne(schema.docsBranches.id, excludedBranchId)
          : undefined,
      ),
    )
    .limit(1);

  return Boolean(branch);
}

async function countBranchChanges(
  db: SelectDatabase,
  branchId: string,
): Promise<number> {
  const [result] = await db
    .select({ value: count() })
    .from(schema.docsBranchChanges)
    .where(eq(schema.docsBranchChanges.branchId, branchId));

  return result?.value ?? 0;
}

function toNamedBranch(
  row: typeof schema.docsBranches.$inferSelect,
): StoredNamedDocsBranch {
  const branch = toStoredBranch(row);

  if (branch.kind !== "named") {
    throw new Error("Expected a named branch");
  }

  return branch;
}
