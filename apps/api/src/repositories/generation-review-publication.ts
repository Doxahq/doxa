import { and, eq } from "drizzle-orm";
import { schema } from "@doxahq/db";
import {
  contentVersionStatePrefix,
  generationStateOwnerVersionId,
} from "@doxahq/docs-engine";
import { DocsContentError } from "../services/docs-content/errors";
import {
  allocateBranchName,
  type ReviewTransaction,
  type StoredGenerationReview,
} from "./generation-review-records";

/** The generation fields that a published version records. */
export interface PublicationBaseline {
  sourceRevision: string | null;
  sourceTreeHash: string | null;
  generatorFingerprint: string | null;
  generationStatePrefix: string;
}

/**
 * Locks the open review that publishing this branch closes. An ordinary
 * branch closes none. A review branch whose review is closed cannot publish.
 */
export async function lockReviewForPublication(
  tx: ReviewTransaction,
  branch: Pick<typeof schema.docsBranches.$inferSelect, "id" | "purpose">,
): Promise<StoredGenerationReview | null> {
  if (branch.purpose !== "generation_review") {
    return null;
  }

  const [review] = await tx
    .select()
    .from(schema.generationReviews)
    .where(
      and(
        eq(schema.generationReviews.branchId, branch.id),
        eq(schema.generationReviews.status, "open"),
      ),
    )
    .for("update")
    .limit(1);

  if (!review) {
    throw new DocsContentError(
      "conflict",
      "This generation review is closed. Start a new generation.",
    );
  }

  return review;
}

/**
 * The generation fields of a new published version. A reviewed generation
 * takes them from its staged run. An editor publication keeps the fields of
 * the version it was based on, so the next run still builds on that run and
 * respects the pages that the publication changed (see page ownership).
 * A base without generation state gives no baseline.
 */
export async function publicationBaseline(
  tx: ReviewTransaction,
  input: {
    siteId: string;
    versionId: string;
    baseVersionId: string;
    review: StoredGenerationReview | null;
  },
): Promise<PublicationBaseline> {
  const source = await readGenerationFields(
    tx,
    input.review?.generatedVersionId ?? input.baseVersionId,
  );
  if (!source || source.siteId !== input.siteId) {
    throw new Error("The version that a publication builds on is missing.");
  }

  const hasBaseline =
    source.sourceRevision !== null &&
    generationStateOwnerVersionId(input.siteId, source.generationStatePrefix) !==
      null;
  if (!hasBaseline) {
    return {
      sourceRevision: null,
      sourceTreeHash: null,
      generatorFingerprint: null,
      generationStatePrefix: contentVersionStatePrefix(
        input.siteId,
        input.versionId,
      ),
    };
  }

  return {
    sourceRevision: source.sourceRevision,
    sourceTreeHash: source.sourceTreeHash,
    generatorFingerprint: source.generatorFingerprint,
    generationStatePrefix: source.generationStatePrefix,
  };
}

async function readGenerationFields(tx: ReviewTransaction, versionId: string) {
  const [version] = await tx
    .select({
      siteId: schema.docsVersions.siteId,
      sourceRevision: schema.docsVersions.sourceRevision,
      sourceTreeHash: schema.docsVersions.sourceTreeHash,
      generatorFingerprint: schema.docsVersions.generatorFingerprint,
      generationStatePrefix: schema.docsVersions.generationStatePrefix,
    })
    .from(schema.docsVersions)
    .where(eq(schema.docsVersions.id, versionId))
    .limit(1);

  return version ?? null;
}

/**
 * Marks the review as published. When the review replaces hand-written
 * content, the previous main stays reachable as a backup branch.
 */
export async function closePublishedReview(
  tx: ReviewTransaction,
  input: {
    review: StoredGenerationReview;
    siteId: string;
    ownerUserId: string;
    actorUserId: string;
    previousVersionId: string;
    publishedVersionId: string;
    publishedAt: Date;
  },
): Promise<{ backupBranchName: string | null }> {
  const backup = input.review.createsBackup
    ? await createBackupBranch(tx, input)
    : null;

  await tx
    .update(schema.generationReviews)
    .set({
      status: "published",
      publishedVersionId: input.publishedVersionId,
      backupBranchId: backup?.id ?? null,
      closedAt: input.publishedAt,
      closedByUserId: input.actorUserId,
      updatedAt: input.publishedAt,
    })
    .where(eq(schema.generationReviews.id, input.review.id));

  return { backupBranchName: backup?.name ?? null };
}

async function createBackupBranch(
  tx: ReviewTransaction,
  input: {
    siteId: string;
    ownerUserId: string;
    previousVersionId: string;
    publishedAt: Date;
  },
): Promise<{ id: string; name: string }> {
  const name = await allocateBranchName(
    tx,
    input.siteId,
    `backup-${input.publishedAt.toISOString().slice(0, 10)}`,
  );
  const [branch] = await tx
    .insert(schema.docsBranches)
    .values({
      siteId: input.siteId,
      kind: "named",
      purpose: "generation_backup",
      name,
      ownerUserId: input.ownerUserId,
      baseVersionId: input.previousVersionId,
    })
    .returning({ id: schema.docsBranches.id });

  if (!branch) {
    throw new Error("Backup branch insert returned no row");
  }

  return { id: branch.id, name };
}
