import { and, eq, like } from "drizzle-orm";
import { schema, type DoxaDb } from "@doxahq/db";
import {
  branchPathSchema,
  branchRefSchema,
} from "@doxahq/contracts/docs-branches";
import type { DocsBranchStore } from "./docs-branches";
import { storedBranchAssetBytes } from "../services/docs-branches/assets/asset-pointer";
import { retireBranchPreview } from "./docs-branch-preview-gc";
import { followReviewPageMoves } from "./generation-review-records";
import {
  runWithSiteLock,
  SITE_LOCK_BUSY,
  SITE_LOCKS,
  type DoxaTransaction,
} from "./site-advisory-lock";

const INSERT_CHUNK_SIZE = 200;

export async function writeBranchChanges(
  db: DoxaDb,
  input: Parameters<DocsBranchStore["writeChanges"]>[0],
): ReturnType<DocsBranchStore["writeChanges"]> {
  for (const change of input.changes) {
    branchPathSchema.parse(change.path);
  }

  if (!input.assetQuota) {
    return db.transaction((tx) => writeInTransaction(tx, input));
  }

  const siteId = await ownedSiteId(db, input);
  if (!siteId) return "not_found";
  // The site lock comes before the branch lock: a holder of the site lock can
  // wait for a branch, but a holder of a branch lock never waits for the site.
  const outcome = await runWithSiteLock(db, SITE_LOCKS.branchAssetQuota, siteId, (tx) =>
    writeInTransaction(tx, input),
  );
  return outcome === SITE_LOCK_BUSY ? "quota_busy" : outcome;
}

async function ownedSiteId(
  db: DoxaDb | DoxaTransaction,
  input: { projectId: string; userId: string },
): Promise<string | null> {
  const [owned] = await db
    .select({ siteId: schema.docsSites.id })
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
  return owned?.siteId ?? null;
}

async function writeInTransaction(
  tx: DoxaTransaction,
  input: Parameters<DocsBranchStore["writeChanges"]>[0],
): ReturnType<DocsBranchStore["writeChanges"]> {
  const siteId = await ownedSiteId(tx, input);
  if (!siteId) return "not_found";

  // The branch lock alone orders this write against publish, sync, and
  // discard, because each of them locks the branch row too. The site row
  // stays free, so writes to other branches of the site do not wait.
  const [branch] = await tx
    .select()
    .from(schema.docsBranches)
    .where(
      and(
        eq(schema.docsBranches.id, input.branchId),
        eq(schema.docsBranches.siteId, siteId),
        eq(schema.docsBranches.ownerUserId, input.userId),
      ),
    )
    .for("update")
    .limit(1);

  if (!branch) {
    return "not_found";
  }

  if (branch.revision !== input.expectedRevision) {
    return "revision_changed";
  }

  if (input.assetQuota) {
    const usedBytes = await sumSiteBranchAssetBytes(tx, siteId);
    if (usedBytes + input.assetQuota.addedBytes > input.assetQuota.maxBytes) {
      return "storage_quota_exceeded";
    }
  }

  const applied = await applyBranchChangeWrites(tx, {
    branchId: branch.id,
    userId: input.userId,
    origin: input.origin,
    changes: input.changes,
  });

  if (applied !== "applied") {
    return applied;
  }

  if (branch.purpose === "generation_review" && input.hrefMoves) {
    await followReviewPageMoves(tx, {
      branchId: branch.id,
      moves: input.hrefMoves,
    });
  }

  await tx
    .update(schema.docsBranches)
    .set({
      revision: branch.revision + 1,
      updatedAt: new Date(),
    })
    .where(eq(schema.docsBranches.id, branch.id));

  return "written";
}

/** What the image rows of all branches of the site store. */
export async function sumSiteBranchAssetBytes(
  db: DoxaDb | DoxaTransaction,
  siteId: string,
): Promise<number> {
  const rows = await db
    .select({ content: schema.docsBranchChanges.content })
    .from(schema.docsBranchChanges)
    .innerJoin(
      schema.docsBranches,
      eq(schema.docsBranches.id, schema.docsBranchChanges.branchId),
    )
    .where(
      and(
        eq(schema.docsBranches.siteId, siteId),
        eq(schema.docsBranchChanges.kind, "upsert"),
        like(schema.docsBranchChanges.path, "assets/%"),
      ),
    );
  return storedBranchAssetBytes(rows.map((row) => row.content ?? ""));
}

type BranchWriteTransaction = DoxaTransaction;

/**
 * Applies working changes to a branch that the caller has locked, inside the
 * caller's transaction. It checks the branch limits on the result and leaves
 * the revision to the caller.
 */
export async function applyBranchChangeWrites(
  tx: BranchWriteTransaction,
  input: {
    branchId: string;
    userId: string;
    origin: Parameters<DocsBranchStore["writeChanges"]>[0]["origin"];
    changes: Parameters<DocsBranchStore["writeChanges"]>[0]["changes"];
  },
): Promise<"applied" | "too_many_changes" | "branch_too_large"> {
  const existing = await tx
    .select({
      path: schema.docsBranchChanges.path,
      byteSize: schema.docsBranchChanges.byteSize,
    })
    .from(schema.docsBranchChanges)
    .where(eq(schema.docsBranchChanges.branchId, input.branchId));

  const sizes = new Map(existing.map((row) => [row.path, row.byteSize]));

  for (const change of input.changes) {
    if (change.kind === "reset") {
      sizes.delete(change.path);
    } else {
      sizes.set(change.path, change.kind === "upsert" ? change.byteSize : 0);
    }
  }

  if (sizes.size > 2000) {
    return "too_many_changes";
  }

  if (
    [...sizes.values()].reduce((sum, size) => sum + size, 0) >
    32 * 1024 * 1024
  ) {
    return "branch_too_large";
  }

  for (const change of input.changes) {
    if (change.kind === "reset") {
      await tx
        .delete(schema.docsBranchChanges)
        .where(
          and(
            eq(schema.docsBranchChanges.branchId, input.branchId),
            eq(schema.docsBranchChanges.path, change.path),
          ),
        );

      continue;
    }

    const value =
      change.kind === "upsert"
        ? {
            content: change.content,
            contentSha256: change.contentSha256,
            byteSize: change.byteSize,
          }
        : { content: null, contentSha256: null, byteSize: 0 };
    await tx
      .insert(schema.docsBranchChanges)
      .values({
        branchId: input.branchId,
        path: change.path,
        kind: change.kind,
        updatedByUserId: input.userId,
        origin: input.origin,
        ...value,
      })
      .onConflictDoUpdate({
        target: [
          schema.docsBranchChanges.branchId,
          schema.docsBranchChanges.path,
        ],
        set: {
          kind: change.kind,
          updatedByUserId: input.userId,
          origin: input.origin,
          updatedAt: new Date(),
          ...value,
        },
      });
  }

  return "applied";
}

export async function discardBranch(
  db: DoxaDb,
  input: Parameters<DocsBranchStore["discard"]>[0],
): ReturnType<DocsBranchStore["discard"]> {
  if (!branchRefSchema.safeParse(input.branch).success) {
    return null;
  }

  return db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ siteId: schema.docsSites.id })
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

    if (!owned) {
      return null;
    }

    const condition =
      input.branch === "main"
        ? and(
            eq(schema.docsBranches.kind, "hidden"),
            eq(schema.docsBranches.ownerUserId, input.userId),
          )
        : and(
            eq(schema.docsBranches.id, input.branch),
            eq(schema.docsBranches.kind, "named"),
          );
    const [branch] = await tx
      .select()
      .from(schema.docsBranches)
      .where(
        and(
          eq(schema.docsBranches.siteId, owned.siteId),
          eq(schema.docsBranches.ownerUserId, input.userId),
          condition,
        ),
      )
      .for("update")
      .limit(1);

    if (!branch) {
      return input.branch === "main"
        ? { revision: 0, collectEntryIds: [] }
        : null;
    }

    if (branch.kind === "hidden") {
      const collectEntryIds = await retireBranchPreview(tx, {
        branchId: branch.id,
        siteId: owned.siteId,
      });
      await tx
        .delete(schema.docsBranches)
        .where(eq(schema.docsBranches.id, branch.id));

      return { revision: branch.revision + 1, collectEntryIds };
    }

    await tx
      .delete(schema.docsBranchChanges)
      .where(eq(schema.docsBranchChanges.branchId, branch.id));
    await tx
      .update(schema.docsBranches)
      .set({ revision: branch.revision + 1, updatedAt: new Date() })
      .where(eq(schema.docsBranches.id, branch.id));

    return { revision: branch.revision + 1, collectEntryIds: [] };
  });
}

/** Replace a branch's rows after checking both immutable inputs under locks. */
export async function synchronizeBranch(
  db: DoxaDb,
  input: Parameters<DocsBranchStore["synchronize"]>[0],
): ReturnType<DocsBranchStore["synchronize"]> {
  for (const change of input.changes) {
    branchPathSchema.parse(change.path);
  }

  if (input.changes.length > 2000) {
    throw new Error("Too many synchronized changes");
  }

  if (
    input.changes.reduce(
      (size, change) => size + (change.kind === "upsert" ? change.byteSize : 0),
      0,
    ) >
    32 * 1024 * 1024
  ) {
    throw new Error("Synchronized branch exceeds size limit");
  }

  return db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ siteId: schema.docsSites.id })
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

    if (!owned) {
      return "not_found";
    }

    const [site] = await tx
      .select({ publishedVersionId: schema.docsSites.publishedVersionId })
      .from(schema.docsSites)
      .where(eq(schema.docsSites.id, owned.siteId))
      .for("update")
      .limit(1);

    if (site?.publishedVersionId !== input.expectedMainVersionId) {
      return "main_changed";
    }

    const [branch] = await tx
      .select()
      .from(schema.docsBranches)
      .where(
        and(
          eq(schema.docsBranches.id, input.branchId),
          eq(schema.docsBranches.siteId, owned.siteId),
          eq(schema.docsBranches.ownerUserId, input.userId),
        ),
      )
      .for("update")
      .limit(1);

    if (!branch) {
      return "not_found";
    }

    if (
      branch.revision !== input.expectedRevision ||
      branch.baseVersionId !== input.expectedBaseVersionId
    ) {
      return "revision_changed";
    }

    const previous = await tx
      .select()
      .from(schema.docsBranchChanges)
      .where(eq(schema.docsBranchChanges.branchId, branch.id));

    const previousByPath = new Map(previous.map((row) => [row.path, row]));

    await tx
      .delete(schema.docsBranchChanges)
      .where(eq(schema.docsBranchChanges.branchId, branch.id));

    const rows = input.changes.map((change) => {
      const prior = previousByPath.get(change.path);
      const retained =
        prior?.kind === change.kind &&
        (change.kind === "delete" ||
          (prior.contentSha256 === change.contentSha256 &&
            prior.content === change.content));
      return {
        branchId: branch.id,
        path: change.path,
        kind: change.kind,
        content: change.kind === "upsert" ? change.content : null,
        contentSha256: change.kind === "upsert" ? change.contentSha256 : null,
        byteSize: change.kind === "upsert" ? change.byteSize : 0,
        updatedByUserId: retained ? prior.updatedByUserId : input.userId,
        origin: retained ? prior.origin : ("editor" as const),
        updatedAt: retained ? prior.updatedAt : new Date(),
      };
    });

    // One statement per chunk instead of one per row. The chunk keeps each
    // statement far below the Postgres limit of 65535 bind parameters.
    for (let start = 0; start < rows.length; start += INSERT_CHUNK_SIZE) {
      await tx
        .insert(schema.docsBranchChanges)
        .values(rows.slice(start, start + INSERT_CHUNK_SIZE));
    }
    await tx
      .update(schema.docsBranches)
      .set({
        baseVersionId: input.expectedMainVersionId,
        revision: branch.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(schema.docsBranches.id, branch.id));

    return "synchronized";
  });
}
