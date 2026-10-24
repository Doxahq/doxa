import { useCallback, useEffect, useState } from "react"
import type { GenerationReviewPage } from "@doxahq/contracts/generation-reviews"

import { restoringDecision } from "~/lib/dashboard/generation-review-model"
import type { ReviewBarDecision, ReviewDecisionOptions } from "~/lib/dashboard/use-review-decisions"

type DecideReviewPage = (
  page: GenerationReviewPage,
  decision: ReviewBarDecision,
  options?: ReviewDecisionOptions,
) => Promise<boolean>

export interface ReviewRestore {
  /** True while the page is restored and the editor does not show it yet. */
  isRestoring: (page: GenerationReviewPage) => boolean
  /** Puts the page back on the review branch and keeps the focus on it. */
  restore: (page: GenerationReviewPage) => void
}

/**
 * Restores a page that a decision took off the review branch, where the
 * person is. The editor opens the page only once the branch lists it, so
 * until the editor shows the page, the page counts as restoring. The caller
 * keeps its notice up meanwhile, and the editor never shows the page that
 * was open before.
 *
 * `editorPageHref` is the page that the editor shows, null while it loads.
 */
export function useReviewRestore(
  focusedPage: GenerationReviewPage | null,
  editorPageHref: string | null,
  decide: DecideReviewPage,
): ReviewRestore {
  // The review href of the page being restored.
  const [restoringHref, setRestoringHref] = useState<string | null>(null)

  const isShown = focusedPage !== null && focusedPage.href === restoringHref && editorPageHref === focusedPage.branchHref
  useEffect(() => {
    if (isShown) setRestoringHref(null)
  }, [isShown])

  const restore = useCallback(
    (page: GenerationReviewPage) => {
      setRestoringHref(page.href)
      void decide(page, restoringDecision(page), { advance: false }).then((saved) => {
        if (!saved) setRestoringHref((current) => (current === page.href ? null : current))
      })
    },
    [decide],
  )

  const isRestoring = useCallback(
    (page: GenerationReviewPage) => page.href === restoringHref && editorPageHref !== page.branchHref,
    [editorPageHref, restoringHref],
  )

  return { isRestoring, restore }
}
