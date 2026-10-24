import { useCallback, useMemo, useState } from "react"
import type { GenerationReviewDecision, GenerationReviewPage } from "@doxahq/contracts/generation-reviews"
import { toast } from "sonner"

import {
  nextToReviewHref,
  REVIEW_CHANGE_COPY,
  REVIEW_STATE_LABEL,
  reviewChoice,
  reviewState,
  type ReviewState,
} from "~/lib/dashboard/generation-review-model"
import type { GenerationReviewActions } from "~/lib/dashboard/use-content-review"

/** A decision that the review bar sends for its page. */
export type ReviewBarDecision = "accepted" | "rejected" | "undecided"

/** How a decision moves the review on. */
export interface ReviewDecisionOptions {
  /** False keeps the focus on the decided page. The review moves on to the next page to review by default. */
  advance?: boolean
}

/** One page and the decision that it gets. */
export interface ReviewDecisionEntry {
  page: GenerationReviewPage
  decision: ReviewBarDecision
}

/** Decisions that would remove pages that the person edited, waiting for them to confirm. */
export interface EditsAtRisk {
  entries: readonly ReviewDecisionEntry[]
  options: ReviewDecisionOptions
}

export interface ReviewDecisions {
  /** Decides on a page. Resolves to true once the decision is saved. */
  decide: (page: GenerationReviewPage, decision: ReviewBarDecision, options?: ReviewDecisionOptions) => Promise<boolean>
  /**
   * Gives the same decision to every page of a list, in one save, such as a
   * sidebar group. A page that already holds the decision stays as it is.
   * The focus stays where it is. Resolves to true once the decisions are saved.
   */
  decideAll: (pages: readonly GenerationReviewPage[], decision: GenerationReviewDecision) => Promise<boolean>
  /** The decisions that wait for the person to confirm, or null. */
  editsAtRisk: EditsAtRisk | null
  /** Saves the waiting decisions, edits dropped. */
  confirmEditsAtRisk: () => void
  /** Leaves the pages and their edits as they are. */
  cancelEditsAtRisk: () => void
}

interface DecisionRun extends EditsAtRisk {
  /** True drops the person's edits on the pages that the decisions remove. */
  discardEdits: boolean
  /** False saves the decisions without the toast, as Undo does. */
  announce: boolean
}

/** The pages of a list that a decision changes: those that do not hold it yet. */
export function pagesToDecide(
  pages: readonly GenerationReviewPage[],
  decision: GenerationReviewDecision,
): GenerationReviewPage[] {
  return pages.filter((page) => reviewState(page) !== decision)
}

/** The decision that puts a page back in the state that it had. */
function undoDecision(state: ReviewState): ReviewBarDecision {
  return state === "to_review" ? "undecided" : state
}

/** The toast title and description of saved decisions. */
function announcement(entries: readonly ReviewDecisionEntry[], decision: GenerationReviewDecision) {
  const [first] = entries
  if (entries.length === 1) {
    return { title: `${REVIEW_STATE_LABEL[decision]} · ${first.page.title}`, description: reviewChoice(first.page, decision).outcome }
  }

  // A group holds one kind of change, so one outcome describes every page.
  const tag = REVIEW_CHANGE_COPY[first.page.change].tag.toLowerCase()
  return {
    title: `${REVIEW_STATE_LABEL[decision]} · ${entries.length} ${tag} pages`,
    description: reviewChoice(first.page, decision).outcome,
  }
}

/**
 * Decides on review pages. After a decision on one page the review moves on
 * to the next page to review, unless the caller keeps it on the page, and a
 * toast says what the decision does, with Undo. Undo puts each page back as
 * it was, to review again when nobody had decided.
 *
 * Decisions that would remove pages that the person edited do not save:
 * they wait in `editsAtRisk` until the person confirms or cancels them.
 */
export function useReviewDecisions(
  pages: readonly GenerationReviewPage[],
  actions: Pick<GenerationReviewActions, "decide">,
  focusOn: (href: string) => void,
): ReviewDecisions {
  const { decide: save } = actions
  const [editsAtRisk, setEditsAtRisk] = useState<EditsAtRisk | null>(null)

  const run = useCallback(
    async ({ entries, options, discardEdits, announce }: DecisionRun): Promise<boolean> => {
      const previous = entries.map(({ page }) => ({ page, decision: undoDecision(reviewState(page)) }))
      const result = await save({
        decisions: entries.map(({ page, decision }) => ({ href: page.href, decision })),
        discardEdits,
      })
      if (result === "edits_at_risk") setEditsAtRisk({ entries, options })
      if (result !== "saved") return false

      const decision = entries[0]?.decision
      if (!announce || decision === undefined || decision === "undecided") return true

      // The order does not change with a decision, so the pages from before it still give the next page.
      const next =
        options.advance === false || entries.length > 1 ? null : nextToReviewHref(pages, entries[0].page.branchHref)
      if (next) focusOn(next)
      const { title, description } = announcement(entries, decision)
      toast(title, {
        description,
        action: {
          label: "Undo",
          onClick: () => {
            if (entries.length === 1) focusOn(entries[0].page.branchHref)
            void run({ entries: previous, options: { advance: false }, discardEdits: false, announce: false })
          },
        },
      })
      return true
    },
    [focusOn, pages, save],
  )

  const decide = useCallback(
    (page: GenerationReviewPage, decision: ReviewBarDecision, options: ReviewDecisionOptions = {}) =>
      run({ entries: [{ page, decision }], options, discardEdits: false, announce: true }),
    [run],
  )

  const decideAll = useCallback(
    async (list: readonly GenerationReviewPage[], decision: GenerationReviewDecision) => {
      const entries = pagesToDecide(list, decision).map((page) => ({ page, decision }))
      if (entries.length === 0) return true
      return run({ entries, options: { advance: false }, discardEdits: false, announce: true })
    },
    [run],
  )

  const confirmEditsAtRisk = useCallback(() => {
    if (!editsAtRisk) return
    setEditsAtRisk(null)
    void run({ ...editsAtRisk, discardEdits: true, announce: true })
  }, [editsAtRisk, run])

  const cancelEditsAtRisk = useCallback(() => setEditsAtRisk(null), [])

  return useMemo(
    () => ({ decide, decideAll, editsAtRisk, confirmEditsAtRisk, cancelEditsAtRisk }),
    [cancelEditsAtRisk, confirmEditsAtRisk, decide, decideAll, editsAtRisk],
  )
}
