import { and, asc, eq, like, or } from "drizzle-orm";
import { schema, type DoxaDb } from "@doxahq/db";
import {
  generationReviewReasonSchema,
  type GenerationReviewPage,
  type GenerationReviewPageChange,
  type GenerationReviewPageDecision,
  type GenerationReviewReason,
} from "@doxahq/contracts/generation-reviews";
import { z } from "zod";

export type ReviewTransaction = Parameters<
  Parameters<DoxaDb["transaction"]>[0]
>[0];
type ReviewDatabase = DoxaDb | ReviewTransaction;

export type StoredGenerationReview = typeof schema.generationReviews.$inferSelect;

export interface StoredGenerationReviewPage {
  href: string;
  /** Where a person renamed or moved the page on the review branch, else null. */
  branchHref: string | null;
  title: string;
  change: GenerationReviewPageChange;
  decision: GenerationReviewPageDecision;
  reasons: GenerationReviewReason[];
  decidedAt: Date | null;
}

/** A page that a save writes, with the decision it keeps or starts with. */
export type GenerationReviewPageWrite = Omit<
  StoredGenerationReviewPage,
  "decidedAt"
> & { decidedByUserId: string | null; decidedAt: Date | null };

const MAX_BRANCH_NAME_ATTEMPTS = 50;
const storedReasonsSchema = z.array(generationReviewReasonSchema);

export function toStoredReviewPage(
  row: typeof schema.generationReviewPages.$inferSelect,
): StoredGenerationReviewPage {
  return {
    href: row.href,
    branchHref: row.branchHref,
    title: row.title,
    change: row.change,
    decision: row.decision,
    reasons: storedReasonsSchema.parse(row.reasons),
    decidedAt: row.decidedAt,
  };
}

export function toReviewPageDto(
  page: StoredGenerationReviewPage,
): GenerationReviewPage {
  return {
    href: page.href,
    branchHref: page.branchHref ?? page.href,
    title: page.title,
    change: page.change,
    decision: page.decision,
    reasons: page.reasons,
    decidedAt: page.decidedAt?.toISOString() ?? null,
  };
}

export async function listReviewPages(
  db: ReviewDatabase,
  reviewId: string,
): Promise<StoredGenerationReviewPage[]> {
  const rows = await db
    .select()
    .from(schema.generationReviewPages)
    .where(eq(schema.generationReviewPages.reviewId, reviewId))
    // A decision rewrites its row, so without an order the row moves.
    .orderBy(asc(schema.generationReviewPages.href));

  return rows.map(toStoredReviewPage);
}

export async function replaceReviewPages(
  tx: ReviewTransaction,
  reviewId: string,
  pages: readonly GenerationReviewPageWrite[],
): Promise<void> {
  await tx
    .delete(schema.generationReviewPages)
    .where(eq(schema.generationReviewPages.reviewId, reviewId));

  if (pages.length === 0) {
    return;
  }

  await tx.insert(schema.generationReviewPages).values(
    pages.map((page) => ({
      reviewId,
      href: page.href,
      branchHref: page.branchHref,
      title: page.title,
      change: page.change,
      decision: page.decision,
      reasons: page.reasons,
      decidedByUserId: page.decidedByUserId,
      decidedAt: page.decidedAt,
    })),
  );
}

/** One page that changed its href on a branch: renamed, or moved to another section. */
export interface PageHrefMove {
  from: string;
  to: string;
}

/**
 * Keeps the pages of the open review of a branch on their branch hrefs
 * after a person renamed or moved them there. The caller holds the branch
 * lock, inside the transaction that writes the move.
 */
export async function followReviewPageMoves(
  tx: ReviewTransaction,
  input: { branchId: string; moves: readonly PageHrefMove[] },
): Promise<void> {
  if (input.moves.length === 0) return;

  const [review] = await tx
    .select({ id: schema.generationReviews.id })
    .from(schema.generationReviews)
    .where(
      and(
        eq(schema.generationReviews.branchId, input.branchId),
        eq(schema.generationReviews.status, "open"),
      ),
    )
    .limit(1);
  if (!review) return;

  const pages = await listReviewPages(tx, review.id);
  await setReviewPageBranchHrefs(tx, review.id, followMoves(pages, input.moves));
}

/** The new branch href of each review page that a move takes along, by review href. */
export function followMoves(
  pages: readonly Pick<StoredGenerationReviewPage, "href" | "branchHref">[],
  moves: readonly PageHrefMove[],
): Map<string, string> {
  const destinations = new Map(moves.map((move) => [move.from, move.to]));
  const moved = new Map<string, string>();
  for (const page of pages) {
    const to = destinations.get(page.branchHref ?? page.href);
    if (to !== undefined) moved.set(page.href, to);
  }

  return moved;
}

/**
 * Records where review pages are on the review branch, by review href. A
 * page back at its own href stores null.
 */
export async function setReviewPageBranchHrefs(
  tx: ReviewTransaction,
  reviewId: string,
  branchHrefs: ReadonlyMap<string, string | null>,
): Promise<void> {
  for (const [href, branchHref] of branchHrefs) {
    await tx
      .update(schema.generationReviewPages)
      .set({ branchHref: branchHref === href ? null : branchHref })
      .where(
        and(
          eq(schema.generationReviewPages.reviewId, reviewId),
          eq(schema.generationReviewPages.href, href),
        ),
      );
  }
}

/**
 * The first free named-branch name of a site: `base`, then `base-2`,
 * `base-3`, and so on. The caller holds the site lock, so the name stays
 * free until its insert.
 */
export async function allocateBranchName(
  tx: ReviewTransaction,
  siteId: string,
  base: string,
): Promise<string> {
  const rows = await tx
    .select({ name: schema.docsBranches.name })
    .from(schema.docsBranches)
    .where(
      and(
        eq(schema.docsBranches.siteId, siteId),
        eq(schema.docsBranches.kind, "named"),
        or(
          eq(schema.docsBranches.name, base),
          like(schema.docsBranches.name, `${base}-%`),
        ),
      ),
    );
  const taken = new Set(rows.map((row) => row.name));

  for (let attempt = 1; attempt <= MAX_BRANCH_NAME_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(`No free branch name starts with ${base}.`);
}

/**
 * Closes the open review of a branch that the caller erases in the same
 * transaction. Without it, the review would stay open with no branch.
 */
export async function discardReviewOfBranch(
  tx: ReviewTransaction,
  input: { branchId: string; actorUserId: string },
): Promise<void> {
  const closedAt = new Date();
  await tx
    .update(schema.generationReviews)
    .set({
      status: "discarded",
      closedAt,
      closedByUserId: input.actorUserId,
      updatedAt: closedAt,
    })
    .where(
      and(
        eq(schema.generationReviews.branchId, input.branchId),
        eq(schema.generationReviews.status, "open"),
      ),
    );
}
