import { and, eq } from "drizzle-orm";
import { createDb, schema, type DoxaDb } from "@doxahq/db";
import type {
  GenerationReviewPageDecision,
  OwnedPageFlag,
  PageLock,
} from "@doxahq/contracts/generation-reviews";
import type { BranchChangeWrite } from "./docs-branches";
import { toStoredChange, type StoredBranchChange } from "./docs-branch-records";
import { applyBranchChangeWrites } from "./docs-branch-writes";
import { retireBranchPreview } from "./docs-branch-preview-gc";
import { hasHandWrittenPublication } from "./docs-publications";
import { retireDocsVersion } from "./docs-version-retirement";
import { listSiteLocks } from "./page-locks";
import { appendJobEvent } from "./job-events";
import {
  allocateBranchName,
  listReviewPages,
  replaceReviewPages,
  setReviewPageBranchHrefs,
  type GenerationReviewPageWrite,
  type ReviewTransaction,
  type StoredGenerationReview,
  type StoredGenerationReviewPage,
} from "./generation-review-records";

export const REVIEW_BRANCH_NAME = "generation-review";

export interface ReviewVersion {
  versionId: string;
  artifactPrefix: string;
}

export interface ReviewBranchSnapshot {
  id: string;
  name: string;
  baseVersionId: string;
  revision: number;
  changes: StoredBranchChange[];
}

export interface OpenReviewSnapshot {
  review: StoredGenerationReview;
  pages: StoredGenerationReviewPage[];
  branch: ReviewBranchSnapshot | null;
}

export interface ReviewSiteSnapshot {
  siteId: string;
  /** The site slug, which names its docs hosts. */
  siteSlug: string;
  projectId: string;
  ownerUserId: string;
  main: ReviewVersion | null;
  openReview: OpenReviewSnapshot | null;
  /** Pages that a person locked against generations. */
  locks: PageLock[];
}

export interface ReviewRunSnapshot extends ReviewSiteSnapshot {
  jobId: string;
  generated: ReviewVersion;
  /** True when the run had no generation baseline and the editor wrote main. */
  replacesEditorContent: boolean;
}

/** What a run save expects to find, so it never overwrites a newer state. */
export interface ReviewExpectation {
  mainVersionId: string;
  openReview: { id: string; branchRevision: number | null } | null;
}

export type SaveRunReviewResult =
  | { status: "saved"; reviewId: string }
  | { status: "stale" }
  | { status: "too_many_changes" }
  | { status: "branch_too_large" };

/**
 * The decision that a page stores. A decision by a person records who made
 * it and when; a taken-back decision records neither.
 */
export interface StoredReviewDecision {
  decision: GenerationReviewPageDecision;
  byPerson: boolean;
}

export type DecideReviewResult =
  | { status: "decided"; revision: number }
  | { status: "stale" }
  | { status: "not_found" }
  | { status: "too_many_changes" }
  | { status: "branch_too_large" };

export class GenerationReviewsRepository {
  private readonly db: DoxaDb;

  constructor(env: Parameters<typeof createDb>[0]) {
    this.db = createDb(env);
  }

  /** The open review of a project that `ownerUserId` owns, or null. */
  async snapshotForProject(input: {
    projectId: string;
    ownerUserId: string;
  }): Promise<ReviewSiteSnapshot | null> {
    const [site] = await this.db
      .select({
        siteId: schema.docsSites.id,
        siteSlug: schema.docsSites.slug,
        projectId: schema.projects.id,
        ownerUserId: schema.projects.userId,
        mainVersionId: schema.docsSites.publishedVersionId,
      })
      .from(schema.projects)
      .innerJoin(
        schema.docsSites,
        eq(schema.docsSites.projectId, schema.projects.id),
      )
      .where(
        and(
          eq(schema.projects.id, input.projectId),
          eq(schema.projects.userId, input.ownerUserId),
        ),
      )
      .limit(1);

    return site ? this.siteSnapshot(site) : null;
  }

  /** The state that a finished production run builds its review from. */
  async snapshotForJob(jobId: string): Promise<ReviewRunSnapshot | null> {
    const [row] = await this.db
      .select({
        jobId: schema.generationJobs.id,
        baselineVersionId: schema.generationJobs.baselineVersionId,
        generatedVersionId: schema.docsVersions.id,
        generatedPrefix: schema.docsVersions.artifactPrefix,
        generatedStatus: schema.docsVersions.status,
        siteId: schema.docsSites.id,
        siteSlug: schema.docsSites.slug,
        projectId: schema.projects.id,
        ownerUserId: schema.projects.userId,
        mainVersionId: schema.docsSites.publishedVersionId,
      })
      .from(schema.generationJobs)
      .innerJoin(
        schema.docsVersions,
        eq(schema.docsVersions.id, schema.generationJobs.docsVersionId),
      )
      .innerJoin(
        schema.docsSites,
        eq(schema.docsSites.id, schema.docsVersions.siteId),
      )
      .innerJoin(
        schema.projects,
        eq(schema.projects.id, schema.docsSites.projectId),
      )
      .where(eq(schema.generationJobs.id, jobId))
      .limit(1);

    if (!row || row.generatedStatus !== "staged") {
      return null;
    }

    const site = await this.siteSnapshot(row);
    return {
      ...site,
      jobId: row.jobId,
      generated: {
        versionId: row.generatedVersionId,
        artifactPrefix: row.generatedPrefix,
      },
      replacesEditorContent:
        row.baselineVersionId === null &&
        (await hasHandWrittenPublication(this.db, row.siteId)),
    };
  }

  /** Records that a finished run changed no page, so it opens no review. */
  async recordUnchangedRun(jobId: string): Promise<void> {
    await appendJobEvent(this.db, {
      jobId,
      type: "review_skipped",
      message: "The generation changed no page, so there is nothing to review.",
      data: { pageCount: 0 },
      source: "api",
    });
  }

  /** True when a review exists for this run, open or closed. */
  async existsForJob(jobId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: schema.generationReviews.id })
      .from(schema.generationReviews)
      .where(eq(schema.generationReviews.jobId, jobId))
      .limit(1);

    return Boolean(row);
  }

  /**
   * Opens the review of a run, or moves the open review to this run. It
   * fails as stale when main or the open review changed after the snapshot.
   */
  saveRunReview(input: {
    siteId: string;
    ownerUserId: string;
    jobId: string;
    generatedVersionId: string;
    createsBackup: boolean;
    ownedPageFlags: readonly OwnedPageFlag[];
    expected: ReviewExpectation;
    pages: readonly GenerationReviewPageWrite[];
    writes: readonly BranchChangeWrite[];
  }): Promise<SaveRunReviewResult> {
    return this.db.transaction(async (tx) => {
      const site = await lockSite(tx, input.siteId);
      if (site?.publishedVersionId !== input.expected.mainVersionId) {
        return { status: "stale" };
      }

      const open = await lockOpenReview(tx, input.siteId);
      if (!sameReview(open, input.expected.openReview)) {
        return { status: "stale" };
      }

      const branchId =
        open?.branch?.id ??
        (await createReviewBranch(tx, {
          siteId: input.siteId,
          ownerUserId: input.ownerUserId,
          baseVersionId: input.expected.mainVersionId,
        }));
      const applied = await applyBranchChangeWrites(tx, {
        branchId,
        userId: input.ownerUserId,
        origin: "agent",
        changes: input.writes,
      });
      if (applied !== "applied") {
        return { status: applied };
      }

      await tx
        .update(schema.docsBranches)
        .set({
          baseVersionId: input.expected.mainVersionId,
          revision: (open?.branch?.revision ?? 0) + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.docsBranches.id, branchId));

      const reviewId = open
        ? await moveReviewToRun(tx, open.review, input)
        : await insertReview(tx, { ...input, branchId });
      await replaceReviewPages(tx, reviewId, input.pages);
      await appendJobEvent(tx, {
        jobId: input.jobId,
        type: "review_ready",
        message: "The generated docs are ready for review.",
        data: { reviewId, pageCount: input.pages.length },
        source: "api",
      });

      return { status: "saved", reviewId };
    });
  }

  /** Records decisions and the branch changes that apply them, at once. */
  decide(input: {
    siteId: string;
    reviewId: string;
    actorUserId: string;
    ownerUserId: string;
    expectedRevision: number;
    decisions: ReadonlyMap<string, StoredReviewDecision>;
    /** Where the decided pages are on the branch now, when a decision moved them. */
    branchHrefs: ReadonlyMap<string, string | null>;
    writes: readonly BranchChangeWrite[];
  }): Promise<DecideReviewResult> {
    return this.db.transaction(async (tx) => {
      const open = await lockOpenReview(tx, input.siteId);
      if (!open || open.review.id !== input.reviewId || !open.branch) {
        return { status: "not_found" };
      }

      if (open.branch.revision !== input.expectedRevision) {
        return { status: "stale" };
      }

      // The review computes these files from decisions, so they stay agent
      // changes. Only a person's edit in the editor is an editor change.
      const applied = await applyBranchChangeWrites(tx, {
        branchId: open.branch.id,
        userId: input.ownerUserId,
        origin: "agent",
        changes: input.writes,
      });
      if (applied !== "applied") {
        return { status: applied };
      }

      const decidedAt = new Date();
      for (const [href, { decision, byPerson }] of input.decisions) {
        await tx
          .update(schema.generationReviewPages)
          .set({
            decision,
            decidedByUserId: byPerson ? input.actorUserId : null,
            decidedAt: byPerson ? decidedAt : null,
          })
          .where(
            and(
              eq(schema.generationReviewPages.reviewId, input.reviewId),
              eq(schema.generationReviewPages.href, href),
            ),
          );
      }
      await setReviewPageBranchHrefs(tx, input.reviewId, input.branchHrefs);

      const revision = open.branch.revision + 1;
      await tx
        .update(schema.docsBranches)
        .set({ revision, updatedAt: decidedAt })
        .where(eq(schema.docsBranches.id, open.branch.id));
      await tx
        .update(schema.generationReviews)
        .set({ updatedAt: decidedAt })
        .where(eq(schema.generationReviews.id, input.reviewId));

      return { status: "decided", revision };
    });
  }

  /**
   * Closes the open review without publishing and erases its branch.
   * Returns the storage entries to collect after the commit, or null when
   * the review is not open.
   */
  discard(input: {
    siteId: string;
    reviewId: string;
    actorUserId: string;
  }): Promise<string[] | null> {
    return this.db.transaction(async (tx) => {
      await lockSite(tx, input.siteId);
      const open = await lockOpenReview(tx, input.siteId);
      if (!open || open.review.id !== input.reviewId) {
        return null;
      }

      const collectEntryIds = open.branch
        ? await retireBranchPreview(tx, {
            branchId: open.branch.id,
            siteId: input.siteId,
          })
        : [];
      if (open.branch) {
        await tx
          .delete(schema.docsBranches)
          .where(eq(schema.docsBranches.id, open.branch.id));
      }

      await tx
        .update(schema.generationReviews)
        .set({
          status: "discarded",
          closedAt: new Date(),
          closedByUserId: input.actorUserId,
          updatedAt: new Date(),
        })
        .where(eq(schema.generationReviews.id, input.reviewId));
      // The staged version leaves with the review. The collector keeps a
      // folder that another version row still shares.
      await retireDocsVersion(
        tx,
        { siteId: input.siteId, versionId: open.review.generatedVersionId },
        "review_discarded",
      );

      return collectEntryIds;
    });
  }

  private async siteSnapshot(site: {
    siteId: string;
    siteSlug: string;
    projectId: string;
    ownerUserId: string;
    mainVersionId: string | null;
  }): Promise<ReviewSiteSnapshot> {
    const [main, openReview, locks] = await Promise.all([
      site.mainVersionId ? readVersion(this.db, site.mainVersionId) : null,
      readOpenReview(this.db, site.siteId),
      listSiteLocks(this.db, site.siteId),
    ]);

    return {
      siteId: site.siteId,
      siteSlug: site.siteSlug,
      projectId: site.projectId,
      ownerUserId: site.ownerUserId,
      main,
      openReview,
      locks,
    };
  }
}

async function readVersion(
  db: DoxaDb,
  versionId: string,
): Promise<ReviewVersion | null> {
  const [version] = await db
    .select({
      versionId: schema.docsVersions.id,
      artifactPrefix: schema.docsVersions.artifactPrefix,
    })
    .from(schema.docsVersions)
    .where(eq(schema.docsVersions.id, versionId))
    .limit(1);

  return version ?? null;
}

async function readOpenReview(
  db: DoxaDb,
  siteId: string,
): Promise<OpenReviewSnapshot | null> {
  const [review] = await db
    .select()
    .from(schema.generationReviews)
    .where(
      and(
        eq(schema.generationReviews.siteId, siteId),
        eq(schema.generationReviews.status, "open"),
      ),
    )
    .limit(1);

  if (!review) {
    return null;
  }

  const [pages, branch] = await Promise.all([
    listReviewPages(db, review.id),
    review.branchId ? readReviewBranch(db, review.branchId) : null,
  ]);
  return { review, pages, branch };
}

async function readReviewBranch(
  db: DoxaDb,
  branchId: string,
): Promise<ReviewBranchSnapshot | null> {
  const [branch] = await db
    .select()
    .from(schema.docsBranches)
    .where(eq(schema.docsBranches.id, branchId))
    .limit(1);

  if (!branch?.name) {
    return null;
  }

  const changes = await db
    .select()
    .from(schema.docsBranchChanges)
    .where(eq(schema.docsBranchChanges.branchId, branchId));

  return {
    id: branch.id,
    name: branch.name,
    baseVersionId: branch.baseVersionId,
    revision: branch.revision,
    changes: changes.map(toStoredChange),
  };
}

async function lockSite(tx: ReviewTransaction, siteId: string) {
  const [site] = await tx
    .select({ publishedVersionId: schema.docsSites.publishedVersionId })
    .from(schema.docsSites)
    .where(eq(schema.docsSites.id, siteId))
    .for("update")
    .limit(1);

  return site ?? null;
}

/**
 * Locks the branch of the open review, then the review: the documented order
 * is site, branch, review. Branch publication takes the same order. The
 * review is read once without a lock to find its branch, then checked again.
 */
async function lockOpenReview(
  tx: ReviewTransaction,
  siteId: string,
): Promise<{
  review: StoredGenerationReview;
  branch: { id: string; revision: number } | null;
} | null> {
  const openReview = and(
    eq(schema.generationReviews.siteId, siteId),
    eq(schema.generationReviews.status, "open"),
  );
  const [candidate] = await tx
    .select({ branchId: schema.generationReviews.branchId })
    .from(schema.generationReviews)
    .where(openReview)
    .limit(1);

  if (!candidate) {
    return null;
  }

  const [branch] = candidate.branchId
    ? await tx
        .select({
          id: schema.docsBranches.id,
          revision: schema.docsBranches.revision,
        })
        .from(schema.docsBranches)
        .where(eq(schema.docsBranches.id, candidate.branchId))
        .for("update")
        .limit(1)
    : [];
  const [review] = await tx
    .select()
    .from(schema.generationReviews)
    .where(openReview)
    .for("update")
    .limit(1);

  if (!review || review.branchId !== candidate.branchId) {
    return null;
  }

  return { review, branch: branch ?? null };
}

function sameReview(
  open: Awaited<ReturnType<typeof lockOpenReview>>,
  expected: ReviewExpectation["openReview"],
): boolean {
  if (!open || !expected) {
    return open === null && expected === null;
  }

  return (
    open.review.id === expected.id &&
    (open.branch?.revision ?? null) === expected.branchRevision
  );
}

async function createReviewBranch(
  tx: ReviewTransaction,
  input: { siteId: string; ownerUserId: string; baseVersionId: string },
): Promise<string> {
  const name = await allocateBranchName(tx, input.siteId, REVIEW_BRANCH_NAME);
  const [branch] = await tx
    .insert(schema.docsBranches)
    .values({
      siteId: input.siteId,
      kind: "named",
      purpose: "generation_review",
      name,
      ownerUserId: input.ownerUserId,
      baseVersionId: input.baseVersionId,
    })
    .returning({ id: schema.docsBranches.id });

  if (!branch) {
    throw new Error("Review branch insert returned no row");
  }

  return branch.id;
}

async function insertReview(
  tx: ReviewTransaction,
  input: {
    siteId: string;
    branchId: string;
    jobId: string;
    generatedVersionId: string;
    createsBackup: boolean;
    ownedPageFlags: readonly OwnedPageFlag[];
  },
): Promise<string> {
  const [review] = await tx
    .insert(schema.generationReviews)
    .values({
      siteId: input.siteId,
      branchId: input.branchId,
      jobId: input.jobId,
      generatedVersionId: input.generatedVersionId,
      createsBackup: input.createsBackup,
      ownedPageFlags: input.ownedPageFlags,
    })
    .returning({ id: schema.generationReviews.id });

  if (!review) {
    throw new Error("Generation review insert returned no row");
  }

  return review.id;
}

/**
 * Moves the open review to a newer run. A review that already keeps a
 * backup keeps that promise, because the newer run replaces the same site.
 */
async function moveReviewToRun(
  tx: ReviewTransaction,
  review: StoredGenerationReview,
  input: {
    jobId: string;
    generatedVersionId: string;
    createsBackup: boolean;
    ownedPageFlags: readonly OwnedPageFlag[];
  },
): Promise<string> {
  await tx
    .update(schema.generationReviews)
    .set({
      jobId: input.jobId,
      generatedVersionId: input.generatedVersionId,
      ownedPageFlags: input.ownedPageFlags,
      createsBackup: review.createsBackup || input.createsBackup,
      updatedAt: new Date(),
    })
    .where(eq(schema.generationReviews.id, review.id));

  return review.id;
}
