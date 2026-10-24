import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { BranchRef } from "@doxahq/contracts/docs-branches"
import type { GenerationReview, GenerationReviewPage } from "@doxahq/contracts/generation-reviews"
import { toast } from "sonner"

import {
  adjacentReviewHref,
  orderReviewPages,
  reviewPageAt,
  reviewProgress,
  type ReviewFilter,
  type ReviewProgress,
} from "~/lib/dashboard/generation-review-model"
import type { ProjectBranchState } from "~/lib/dashboard/project-branch-context"
import { isEditableTarget } from "~/lib/dashboard/shell-context"
import { useGenerationReview } from "~/lib/dashboard/use-generation-review"
import { docsBranchQueryKeys } from "~/lib/queries/docs-branches"
import { generationReviewQueryKeys } from "~/lib/queries/generation-review"

export type GenerationReviewActions = ReturnType<typeof useGenerationReview>

/** The review that the content editor shows while its branch is checked out. */
export interface ContentReviewSession {
  review: GenerationReview
  /** The review branch, which the editor has checked out. */
  branchId: string
  /** The review pages, the pages that need a decision first. */
  pages: GenerationReviewPage[]
  progress: ReviewProgress
  /**
   * The branch href of the page that the reviewer looks at, where the editor
   * opens it. It can be a page that the branch no longer has.
   */
  focusHref: string | null
  /** The review entry of the focused page, or null for a page that the generation left alone. */
  focusedPage: GenerationReviewPage | null
  previousHref: string | null
  nextHref: string | null
  /** The pages that the sidebar list shows. */
  filter: ReviewFilter
}

/**
 * The review mode of the content editor. An open generation review lives on
 * a docs branch, so the editor reviews it by checking that branch out: the
 * mode is on exactly while the review branch is the selected branch.
 */
export function useContentReview(options: {
  projectId: string
  branches: ProjectBranchState
  /** Saves the buffer, then checks out the branch. */
  switchBranch: (branch: BranchRef) => Promise<void>
  /** The page in the URL, which the review opens first when it is a review page. */
  initialHref: string | null
  /** True when the URL asks to open the review, for example from a generation. */
  entryRequested: boolean
  /** Removes the request from the URL once it is handled. */
  onEntryHandled: () => void
  /** The revision of the checked-out branch, which every saved edit raises. */
  branchRevision: number | null
}) {
  const { projectId, branches, switchBranch, entryRequested, onEntryHandled } = options
  const queryClient = useQueryClient()
  const actions = useGenerationReview(projectId)
  const review = actions.review
  const reviewBranchId = review?.branch?.id ?? null
  const isActive = reviewBranchId !== null && branches.branchRef === reviewBranchId

  const pages = useMemo(() => orderReviewPages(review?.pages ?? []), [review?.pages])
  const [initialHref] = useState(options.initialHref)
  // A new review starts on the page in the URL, else on its first page, and
  // pins it, so a decision that reorders the list or a rename keeps it.
  const [focus, setFocus] = useState<ReviewFocus | null>(null)
  if (review && pages.length > 0 && focus?.reviewId !== review.id) {
    setFocus(initialFocus(review.id, pages, initialHref))
  }
  const focusHref = review && focus?.reviewId === review.id ? focusedBranchHref(focus, pages) : null

  const [filter, setFilter] = useState<ReviewFilter>("all")
  const [isFinishOpen, setFinishOpen] = useState(false)

  const focusOn = useCallback((href: string) => {
    if (!review) return
    setFocus({ reviewId: review.id, href, reviewHref: reviewPageAt(pages, href)?.href ?? null })
  }, [pages, review])

  // The review branch can be newer than the cached branch list, so the list
  // reloads before the checkout. A branch outside the list falls back to main.
  const enter = useCallback(async (): Promise<boolean> => {
    if (!reviewBranchId) return false
    if (!branches.branches.some((branch) => branch.id === reviewBranchId)) {
      await queryClient.refetchQueries({ queryKey: docsBranchQueryKeys.list(projectId), exact: true })
    }
    await switchBranch(reviewBranchId)
    return true
  }, [branches.branches, projectId, queryClient, reviewBranchId, switchBranch])

  const exit = useCallback(() => switchBranch("main"), [switchBranch])

  useReviewFollowsBranch(projectId, isActive ? options.branchRevision : null)

  const entryHandledRef = useRef(false)
  useEffect(() => {
    if (!entryRequested) {
      entryHandledRef.current = false
      return
    }
    if (entryHandledRef.current || actions.reviewQuery.isPending || branches.isLoading) return
    entryHandledRef.current = true
    void enter().then((entered) => {
      if (!entered) toast.info("No generation waits for review.")
      onEntryHandled()
    })
  }, [actions.reviewQuery.isPending, branches.isLoading, enter, entryRequested, onEntryHandled])

  const session = useMemo<ContentReviewSession | null>(() => {
    if (!review || !isActive || !reviewBranchId) return null
    return {
      review,
      branchId: reviewBranchId,
      pages,
      progress: reviewProgress(pages),
      focusHref,
      focusedPage: reviewPageAt(pages, focusHref),
      previousHref: adjacentReviewHref(pages, focusHref, -1),
      nextHref: adjacentReviewHref(pages, focusHref, 1),
      filter,
    }
  }, [filter, focusHref, isActive, pages, review, reviewBranchId])

  useReviewStepKeys(session, focusOn)

  return {
    /** The open review, whether or not the editor shows it. */
    review,
    /** The review that the editor shows, or null outside review mode. */
    session,
    actions,
    focusOn,
    setFilter,
    /** The summary that finishes the review, from the top bar or the last decision. */
    finish: { isOpen: isFinishOpen, setOpen: setFinishOpen },
    enter,
    exit,
  }
}

export type ContentReview = ReturnType<typeof useContentReview>

/** The page that the reviewer chose, in one review. */
export interface ReviewFocus {
  reviewId: string
  /** The branch href when the reviewer chose the page. */
  href: string
  /** The review href of a review page, which stays when a person moves the page. */
  reviewHref: string | null
}

/** The page that a review opens first: the page in the URL, else the first review page. */
export function initialFocus(
  reviewId: string,
  pages: readonly GenerationReviewPage[],
  initialHref: string | null,
): ReviewFocus {
  const page = reviewPageAt(pages, initialHref) ?? pages[0]
  return { reviewId, href: page.branchHref, reviewHref: page.href }
}

/**
 * Where the chosen page is now. A review page is followed by its review
 * href, so a rename or a move on the branch takes the focus along.
 */
export function focusedBranchHref(focus: ReviewFocus, pages: readonly GenerationReviewPage[]): string {
  if (focus.reviewHref === null) return focus.href
  return pages.find((page) => page.href === focus.reviewHref)?.branchHref ?? focus.href
}

/**
 * Reloads the review after an edit on its branch. A rename or a move of a
 * review page changes where the review finds that page.
 */
function useReviewFollowsBranch(projectId: string, revision: number | null): void {
  const queryClient = useQueryClient()
  const seenRef = useRef<number | null>(null)
  useEffect(() => {
    const seen = seenRef.current
    seenRef.current = revision
    if (revision === null || seen === null || revision === seen) return
    void queryClient.invalidateQueries({ queryKey: generationReviewQueryKeys.project(projectId) })
  }, [projectId, queryClient, revision])
}

/**
 * J and K step to the next and the previous review page, like a code review.
 * Null turns the keys off.
 */
export function useReviewStepKeys(
  steps: Pick<ContentReviewSession, "previousHref" | "nextHref"> | null,
  focusOn: (href: string) => void,
): void {
  const previousHref = steps?.previousHref ?? null
  const nextHref = steps?.nextHref ?? null
  const isOn = steps !== null
  useEffect(() => {
    if (!isOn) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return
      if (isEditableTarget(event.target)) return
      const href = event.key === "j" ? nextHref : event.key === "k" ? previousHref : null
      if (!href) return
      event.preventDefault()
      focusOn(href)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [focusOn, isOn, nextHref, previousHref])
}
