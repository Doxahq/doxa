import { createContext, useContext, useMemo, type ReactNode } from "react"
import type { GenerationReviewPage } from "@doxahq/contracts/generation-reviews"

import { countReviewChanges, type ReviewChangeCounts } from "~/lib/dashboard/generation-review-model"

const ReviewPageMarksContext = createContext<ReadonlyMap<string, GenerationReviewPage> | null>(null)

/**
 * Gives the rows of the page tree the review entry of their page, by branch
 * href, so a review shows its change dots in the tree without passing them
 * through it. A page that a person moved keeps its dot.
 */
export function ReviewPageMarksProvider({
  pages,
  children,
}: {
  pages: readonly GenerationReviewPage[]
  children: ReactNode
}) {
  const marks = useMemo(() => new Map(pages.map((page) => [page.branchHref, page])), [pages])
  return <ReviewPageMarksContext.Provider value={marks}>{children}</ReviewPageMarksContext.Provider>
}

/** The review entry of a page, or null outside a review and for an unchanged page. */
export function useReviewPageMark(href: string): GenerationReviewPage | null {
  return useContext(ReviewPageMarksContext)?.get(href) ?? null
}

/**
 * The changes among some pages, for a closed group of the tree. Null outside
 * a review, where the tree marks edited pages instead.
 */
export function useReviewChangeCounts(hrefs: readonly string[]): ReviewChangeCounts | null {
  const marks = useContext(ReviewPageMarksContext)
  return marks ? countReviewChanges(marks, hrefs) : null
}
