import { useState } from "react"
import { toast } from "sonner"

import { ReviewFinishDialog } from "~/components/dashboard/content/review/review-finish-dialog"
import { ReviewConfirmDialog } from "~/components/dashboard/review/review-confirm-dialog"
import { Button } from "~/components/ui/button"
import { nextToReviewHref, reviewFinishSummary } from "~/lib/dashboard/generation-review-model"
import type { ContentReviewSession, GenerationReviewActions } from "~/lib/dashboard/use-content-review"

/**
 * The top bar actions of review mode. Finish review sums up the review and
 * publishes it; Discard drops the review. Both leave review mode once they
 * succeed.
 */
export function ReviewActions(props: {
  session: ContentReviewSession
  actions: GenerationReviewActions
  canWrite: boolean
  canPublish: boolean
  /** Whether the finish summary is open, which the last decision can open too. */
  finish: { isOpen: boolean; setOpen: (open: boolean) => void }
  /** Shows the pages to review in the sidebar. */
  onReviewRemaining: (firstHref: string | null) => void
  /** Saves the open page before the publish, so its edits go live too. */
  saveBuffer: () => Promise<boolean>
  /** Leaves review mode after the review closed. */
  onClosed: () => void
}) {
  const { session, actions, finish } = props
  const [isDiscardOpen, setDiscardOpen] = useState(false)
  const isBusy = actions.isPublishing || actions.isDiscarding
  const { toReview } = session.progress
  // A run that only flags owned pages has nothing to publish.
  const flagsOnly = session.pages.length === 0

  async function publish(): Promise<void> {
    if (!(await props.saveBuffer())) return
    const result = await actions.publish(session.review).catch(() => null)
    if (!result) return
    finish.setOpen(false)
    toast.success(
      result.backupBranchName
        ? `Published. Your previous pages are in the branch ${result.backupBranchName}.`
        : "Published. Your live site shows the reviewed pages.",
    )
    props.onClosed()
  }

  async function discard(message: string): Promise<void> {
    const discarded = await actions.discard().then(() => true, () => false)
    if (!discarded) return
    setDiscardOpen(false)
    toast.success(message)
    props.onClosed()
  }

  if (flagsOnly) {
    return props.canWrite ? (
      <Button
        type="button"
        size="sm"
        disabled={isBusy}
        onClick={() => void discard("Dismissed. Your pages stay as you wrote them.")}
      >
        Dismiss review
      </Button>
    ) : null
  }

  return (
    <>
      {props.canWrite ? (
        <Button type="button" variant="outline" size="sm" disabled={isBusy} onClick={() => setDiscardOpen(true)}>
          Discard
        </Button>
      ) : null}
      {props.canPublish ? (
        <Button
          type="button"
          size="sm"
          disabled={isBusy}
          className="gap-2 pr-1.5"
          onClick={() => finish.setOpen(true)}
        >
          Finish review
          <span className="rounded-sm bg-background/15 px-1.5 py-px text-[11px] font-medium tabular-nums max-sm:hidden">
            {toReview > 0 ? `${toReview} left` : "Ready"}
          </span>
        </Button>
      ) : null}
      <ReviewFinishDialog
        open={finish.isOpen}
        onOpenChange={finish.setOpen}
        summary={reviewFinishSummary(session.pages)}
        createsBackup={session.review.createsBackup}
        isPublishing={actions.isPublishing}
        error={actions.publishError}
        onPublish={() => void publish()}
        onReviewRemaining={() => {
          finish.setOpen(false)
          props.onReviewRemaining(nextToReviewHref(session.pages, null))
        }}
      />
      <ReviewConfirmDialog
        open={isDiscardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard this review?"
        description="The generated pages, your decisions and your edits in this review are removed. Your live site does not change."
        confirmLabel="Discard review"
        pendingLabel="Discarding…"
        destructive
        isPending={actions.isDiscarding}
        error={actions.discardError}
        onConfirm={() => void discard("Review discarded. Your live site did not change.")}
      />
    </>
  )
}
