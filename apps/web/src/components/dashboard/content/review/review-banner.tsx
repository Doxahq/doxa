import { Link } from "@tanstack/react-router"
import type { GenerationReview } from "@doxahq/contracts/generation-reviews"
import { ClipboardCheck, ExternalLink, History, X } from "lucide-react"

import { Button } from "~/components/ui/button"
import { shortenGenerationId } from "~/lib/dashboard/generation-model"
import { cn } from "~/lib/utils"

/**
 * A review strip runs the full width of the main area, under the top bar,
 * with no border of its own. Its tint sets it apart from the editor.
 */
export const REVIEW_STRIP_CLASS = "flex shrink-0 flex-col gap-2 bg-primary-wash px-4 py-2.5"

/**
 * Says that the editor shows a generation review, not the person's own
 * work, and links back to the generation that wrote it.
 */
export function ReviewBanner(props: {
  projectId: string
  review: GenerationReview
  onExit: () => void
}) {
  const { review } = props

  return (
    <div
      role="region"
      aria-label="Generation review"
      className={cn(REVIEW_STRIP_CLASS, "lg:flex-row lg:items-center lg:justify-between")}
    >
      <div className="flex min-w-0 items-start gap-3">
        <ClipboardCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary-text" />
        <div className="flex min-w-0 flex-col">
          <p className="text-sm font-medium text-foreground">
            You are reviewing generation{" "}
            <Link
              to="/dashboard/projects/$projectId/generations/$generationId"
              params={{ projectId: props.projectId, generationId: review.jobId }}
              title="View generation"
              className="font-mono text-[13px] text-primary-text underline-offset-2 hover:underline focus-visible:underline"
            >
              {shortenGenerationId(review.jobId)}
            </Link>
          </p>
          <p className="text-[13px] leading-5 text-pretty text-muted-foreground">
            Decide on each changed page. Your live site does not change until you publish.
            {review.createsBackup ? " Publishing keeps your current pages in a backup branch." : ""}
          </p>
        </div>
      </div>
      {/* On a phone the two links show only their icons, so the actions keep one line. */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 pl-7 lg:pl-0">
        <Button variant="ghost" size="sm" asChild>
          <Link
            to="/dashboard/projects/$projectId/generations/$generationId"
            params={{ projectId: props.projectId, generationId: review.jobId }}
          >
            <History aria-hidden="true" />
            <span className="max-sm:sr-only">View generation</span>
          </Link>
        </Button>
        {review.previewUrl ? (
          <Button variant="ghost" size="sm" asChild>
            <a href={review.previewUrl} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden="true" />
              <span className="max-sm:sr-only">Open site preview</span>
            </a>
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={props.onExit}>
          <X aria-hidden="true" />
          Exit review
        </Button>
      </div>
    </div>
  )
}

/** On another branch: tells the person that a generation waits for review. */
export function ReviewWaitingNotice(props: { pageCount: number; onStart: () => void }) {
  return (
    <div className={cn(REVIEW_STRIP_CLASS, "sm:flex-row sm:items-center sm:justify-between")}>
      <p className="flex items-center gap-2.5 text-sm text-foreground">
        <ClipboardCheck aria-hidden="true" className="size-4 shrink-0 text-primary-text" />
        {waitingMessage(props.pageCount)}
      </p>
      <Button type="button" size="sm" className="shrink-0 self-start sm:self-auto" onClick={props.onStart}>
        Start review
      </Button>
    </div>
  )
}

function waitingMessage(pageCount: number): string {
  if (pageCount === 0) return "The code under some of your pages changed. Check them in the review."
  return `A generation changed ${pageCount === 1 ? "1 page" : `${pageCount} pages`}. It waits for your review.`
}
