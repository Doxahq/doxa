import type { GenerationReviewPageChange } from "@doxahq/contracts/generation-reviews"
import { AlertCircle, AlertTriangle, Loader2 } from "lucide-react"

import { plural } from "~/components/dashboard/content/branches/publish-menu-parts"
import { ReviewChangeIcon } from "~/components/dashboard/content/review/review-marks"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import type { ReviewFinishSummary } from "~/lib/dashboard/generation-review-model"

const SECTION_LABEL = "font-mono text-[10.5px] tracking-[0.08em] text-label uppercase"

/**
 * The summary that finishes a review: what goes live, what is dropped, and
 * what still waits for a decision. Publishing applies it.
 */
export function ReviewFinishDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  summary: ReviewFinishSummary
  /** True when publishing keeps the current pages in a backup branch. */
  createsBackup: boolean
  isPublishing: boolean
  error: string | null
  onPublish: () => void
  /** Shows the pages that wait for a decision. */
  onReviewRemaining: () => void
}) {
  const { summary } = props
  const canPublish = summary.live > 0 && !props.isPublishing

  function handleOpenChange(open: boolean): void {
    if (!open && props.isPublishing) return
    props.onOpenChange(open)
  }

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogContent className="overscroll-contain shadow-none">
        <DialogHeader>
          <DialogTitle>Finish review</DialogTitle>
          <DialogDescription className="text-pretty">
            Publishing applies only the changes you accepted.
            {props.createsBackup ? " Your current pages are kept in a backup branch." : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <section aria-label="Goes live" className="flex flex-col gap-2">
            <span className={SECTION_LABEL}>Goes live · {summary.live}</span>
            <SummaryLine change="added" text={plural(summary.added, "new page") + " added"} />
            <SummaryLine change="modified" text={plural(summary.updated, "page") + " updated"} />
            <SummaryLine change="removed" text={plural(summary.deleted, "page") + " deleted"} />
          </section>
          <section aria-label="Discarded" className="flex flex-col gap-1.5 border-t border-divider pt-3.5">
            <span className={SECTION_LABEL}>Discarded · {summary.discarded}</span>
            <p className="text-[13px] text-body">
              Changes you rejected are dropped. Those pages stay exactly as they are now.
            </p>
          </section>
          {summary.toReview > 0 ? (
            <RemainingWarning summary={summary} onReviewRemaining={props.onReviewRemaining} />
          ) : null}
          {props.error ? (
            <Alert variant="destructive" aria-live="polite">
              <AlertCircle aria-hidden="true" />
              <AlertDescription className="break-words">{props.error}</AlertDescription>
            </Alert>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={props.isPublishing}
            onClick={() => handleOpenChange(false)}
          >
            Back to review
          </Button>
          <Button type="button" size="sm" disabled={!canPublish} onClick={props.onPublish}>
            {props.isPublishing ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
            {props.isPublishing
              ? "Publishing…"
              : summary.live > 0
                ? `Publish ${plural(summary.live, "change")}`
                : "Nothing to publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SummaryLine({ change, text }: { change: GenerationReviewPageChange; text: string }) {
  return (
    <span className="flex items-center gap-2.5 text-[13px] text-foreground">
      <ReviewChangeIcon change={change} />
      {text}
    </span>
  )
}

/**
 * The pages that no person decided on yet. Each one holds the generation's
 * change, so the person can publish without deciding on them.
 */
function RemainingWarning(props: { summary: ReviewFinishSummary; onReviewRemaining: () => void }) {
  const { summary } = props
  const title = `${plural(summary.toReview, "change")} ${summary.toReview === 1 ? "is" : "are"} not reviewed yet`
  const detail = "If you publish now, they are published as this review shows them."

  return (
    <div role="status" className="flex items-start gap-2.5 rounded-md border border-warning/35 bg-warning/10 p-3">
      <AlertTriangle aria-hidden="true" className="mt-px size-4 shrink-0 text-warning" />
      <div className="flex flex-1 flex-col gap-2">
        <span className="text-[13px] font-semibold text-warning">{title}</span>
        <span className="text-[12.5px] text-body">{detail}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start border-warning/45 text-warning hover:border-warning"
          onClick={props.onReviewRemaining}
        >
          Review remaining
        </Button>
      </div>
    </div>
  )
}
