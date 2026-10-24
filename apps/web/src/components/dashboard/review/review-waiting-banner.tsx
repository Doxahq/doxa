import { Link } from "@tanstack/react-router"
import type { GenerationReview } from "@doxahq/contracts/generation-reviews"
import { ClipboardCheck } from "lucide-react"

import { plural } from "~/components/dashboard/content/branches/publish-menu-parts"
import { Button } from "~/components/ui/button"

/**
 * Tells the person that a generation waits for review, and links to it.
 * It wears the tint of the review strip in the editor, with no border, as
 * both say the same thing.
 */
export function ReviewWaitingBanner({ projectId, review }: { projectId: string; review: GenerationReview }) {
  return (
    <div
      role="region"
      aria-label="Generation review"
      className="flex flex-col gap-3 rounded-md bg-primary-wash px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-start gap-3">
        <ClipboardCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary-text" />
        <div className="flex min-w-0 flex-col">
          <p className="text-sm font-medium text-foreground">A generation waits for your review</p>
          <p className="text-[13px] leading-5 text-pretty text-muted-foreground">
            It changes {plural(review.pages.length, "page")}. Your live site does not change until you publish.
          </p>
        </div>
      </div>
      <Button size="sm" asChild className="shrink-0">
        <Link to="/dashboard/projects/$projectId/content" params={{ projectId }} search={{ review: true }}>
          Review changes
        </Link>
      </Button>
    </div>
  )
}
