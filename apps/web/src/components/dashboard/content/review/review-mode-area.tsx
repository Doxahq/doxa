import type { ReactNode } from "react"

import { ReviewDiffPane } from "~/components/dashboard/content/review/review-diff-pane"
import { ReviewEditsDialog } from "~/components/dashboard/content/review/review-edits-dialog"
import {
  ReviewAbsentPageNotice,
  ReviewUnchangedPageNotice,
} from "~/components/dashboard/content/review/review-page-notice"
import { isOnReviewBranch } from "~/lib/dashboard/generation-review-model"
import type { CanvasSettings } from "~/lib/dashboard/site-canvas"
import type { ContentReviewSession, GenerationReviewActions } from "~/lib/dashboard/use-content-review"
import type { ContentViewMode } from "~/lib/dashboard/use-project-content"
import type { ReviewDecisions } from "~/lib/dashboard/use-review-decisions"
import { useReviewRestore } from "~/lib/dashboard/use-review-restore"

/**
 * The main area of review mode. Diff shows what the generation changes on
 * the focused page; Write and Split edit it on the review branch, like any
 * branch, while its decision keeps the page there, and offer to restore a
 * page that a decision took off it. The decision decides it, not the page
 * list, so a rename that the review has not loaded yet still shows the
 * editor. A decision that would remove the person's edits asks first.
 */
export function ReviewModeArea(props: {
  projectId: string
  session: ContentReviewSession
  actions: GenerationReviewActions
  /** The decisions of the review, shared with the sidebar groups. */
  decisions: ReviewDecisions
  canWrite: boolean
  viewMode: ContentViewMode
  onViewModeChange: (mode: ContentViewMode) => void
  canvas: CanvasSettings
  /** The address that a preview shows when its page has no URL yet. */
  host: string
  liveDocsUrl: string | null
  onStep: (href: string) => void
  /** Opens the summary that finishes the review. */
  onFinish: () => void
  /** The Write or Split editor of the focused page. */
  editor: ReactNode
  /** The page that the editor shows, null while it loads. */
  editorPageHref: string | null
}) {
  const { session, actions, decisions } = props
  const page = session.focusedPage
  const restore = useReviewRestore(page, props.editorPageHref, decisions.decide)

  function view(): ReactNode {
    if (props.viewMode === "diff") {
      if (!page) {
        const flag = session.review.ownedPageFlags.find((entry) => entry.href === session.focusHref) ?? null
        return <ReviewUnchangedPageNotice flag={flag} onEdit={() => props.onViewModeChange("write")} />
      }

      return (
        <ReviewDiffPane
          projectId={props.projectId}
          session={session}
          page={page}
          decision={{
            canDecide: props.canWrite,
            isSaving: actions.decidingHrefs.includes(page.href),
            disabled:
              decisions.editsAtRisk !== null ||
              actions.isDeciding ||
              actions.isPublishing ||
              actions.isDiscarding,
            onDecide: (decision) => void decisions.decide(page, decision),
          }}
          canvas={props.canvas}
          host={props.host}
          liveDocsUrl={props.liveDocsUrl}
          onStep={props.onStep}
          onFinish={props.onFinish}
        />
      )
    }

    // A restored page keeps the notice until the editor shows it, so the page that was open before never shows.
    const isRestoring = page !== null && restore.isRestoring(page)
    if (page && (!isOnReviewBranch(page) || isRestoring)) {
      return (
        <ReviewAbsentPageNotice
          page={page}
          restore={
            props.canWrite
              ? {
                  isRestoring,
                  disabled:
                    isRestoring || actions.isDeciding || actions.isPublishing || actions.isDiscarding,
                  onRestore: () => restore.restore(page),
                }
              : null
          }
          onShowDiff={() => props.onViewModeChange("diff")}
        />
      )
    }

    return props.editor
  }

  return (
    <>
      {view()}
      <ReviewEditsDialog
        pending={decisions.editsAtRisk}
        onConfirm={decisions.confirmEditsAtRisk}
        onCancel={decisions.cancelEditsAtRisk}
      />
    </>
  )
}
