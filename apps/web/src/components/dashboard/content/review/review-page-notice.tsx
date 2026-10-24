import type { ReactNode } from "react"
import type { GenerationReviewPage, OwnedPageFlag } from "@doxahq/contracts/generation-reviews"
import { ArchiveRestore, FileCheck2, FileX2, GitCompareArrows, Loader2, PenLine } from "lucide-react"

import { EmptyState } from "~/components/dashboard/dashboard-header"
import { Button } from "~/components/ui/button"

/** The main area of review mode when the open view cannot show the page. */
function ReviewNotice(props: { icon: ReactNode; title: string; description: string; action: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto border-t border-border p-6">
      <EmptyState icon={props.icon} title={props.title} description={props.description} action={props.action} />
    </div>
  )
}

/** The Diff view of a page that the generation left alone. */
export function ReviewUnchangedPageNotice(props: { flag: OwnedPageFlag | null; onEdit: () => void }) {
  const description = props.flag
    ? `You own this page, so the generation kept it. Its code changed: ${props.flag.changedPaths.join(", ")}. Check that it is still right.`
    : "The generation left this page as it is. Open it in the editor to read or change it."

  return (
    <ReviewNotice
      icon={<FileCheck2 />}
      title={props.flag ? "Your page" : "No changes"}
      description={description}
      action={
        <Button type="button" variant="outline" size="sm" onClick={props.onEdit}>
          <PenLine aria-hidden="true" />
          Open in Write
        </Button>
      }
    />
  )
}

/** Puts a page that is off the review branch back on it, from the notice. */
export interface ReviewRestoreControl {
  isRestoring: boolean
  disabled: boolean
  onRestore: () => void
}

/**
 * What the notice says about a page that a decision took off the review
 * branch: what happens to it when you publish, and what restoring it does.
 * The page is the open one, so the notice does not name it.
 */
const ABSENT_PAGE_COPY: Record<"added" | "removed", { title: string; outcome: string; restore: string }> = {
  removed: {
    title: "This page will be deleted",
    outcome: "It leaves your site when you publish.",
    restore: "Restore it to keep and edit it.",
  },
  added: {
    title: "This page is discarded",
    outcome: "It will not be published.",
    restore: "Restore it to add and edit it.",
  },
}

/**
 * Write or Split on a review page that a decision took off the branch.
 * Restoring the page changes the decision so the page is back on the branch,
 * and the editor opens it in place.
 */
export function ReviewAbsentPageNotice(props: {
  page: GenerationReviewPage
  /** Null for a role that cannot decide. */
  restore: ReviewRestoreControl | null
  onShowDiff: () => void
}) {
  const { restore } = props
  // A rewritten page is always on the branch, so only a new or a removed page gets here.
  const copy = ABSENT_PAGE_COPY[props.page.change === "added" ? "added" : "removed"]
  const description = restore ? `${copy.outcome} ${copy.restore}` : copy.outcome

  return (
    <ReviewNotice
      icon={<FileX2 />}
      title={copy.title}
      description={description}
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          {restore ? (
            <Button type="button" size="sm" disabled={restore.disabled} onClick={restore.onRestore}>
              {restore.isRestoring ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <ArchiveRestore aria-hidden="true" />
              )}
              {restore.isRestoring ? "Restoring\u2026" : "Restore page"}
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={props.onShowDiff}>
            <GitCompareArrows aria-hidden="true" />
            Show the diff
          </Button>
        </div>
      }
    />
  )
}
