import type {
  GenerationChangedPage,
  GenerationReviewPage,
  GenerationReviewPageChange,
} from "@doxahq/contracts/generation-reviews"

import { orderReviewPages, type ReviewChangeCounts } from "~/lib/dashboard/generation-review-model"

/**
 * The changed pages of a run as review pages, in review order. A changed
 * page is a review page that nobody decides on: it holds the generation's
 * change, as every review page starts, and no decision time. The review
 * list, order and steps then apply to it as they are.
 */
export function toChangesViewPages(pages: readonly GenerationChangedPage[]): GenerationReviewPage[] {
  return orderReviewPages(
    pages.map((page) => ({ ...page, branchHref: page.href, decision: "accepted", decidedAt: null })),
  )
}

/** How many pages each kind of change touches. */
export function countChangedPages(pages: readonly GenerationChangedPage[]): ReviewChangeCounts {
  const counts: ReviewChangeCounts = { added: 0, modified: 0, removed: 0 }
  for (const page of pages) counts[page.change] += 1
  return counts
}

/** What the generation did to a page of a pull request, without a decision to make. */
export const CHANGED_PAGE_SENTENCE: Record<GenerationReviewPageChange, string> = {
  added: "The generation wrote this page for this pull request.",
  modified: "The generation rewrote parts of this page for this pull request.",
  removed: "The generation left this page out for this pull request.",
}
