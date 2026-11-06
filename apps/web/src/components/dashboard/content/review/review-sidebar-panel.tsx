import { useState, type ReactNode } from "react"

import { ReviewChangeList } from "~/components/dashboard/content/review/review-change-list"
import type { ReviewGroupDecisions } from "~/components/dashboard/content/review/review-group-actions"
import { ReviewFlaggedPages } from "~/components/dashboard/content/review/review-flagged-pages"
import { ReviewDecisionMark } from "~/components/dashboard/content/review/review-marks"
import { ReviewOwnedPages } from "~/components/dashboard/content/review/review-owned-pages"
import { ReviewPageNotices } from "~/components/dashboard/content/review/review-page-notices"
import {
  REVIEW_STATE_LABEL,
  type ReviewFilter,
  type ReviewProgress,
  type ReviewState,
} from "~/lib/dashboard/generation-review-model"
import { readFlaggedPages } from "~/lib/dashboard/flagged-pages"
import { readPageNotices } from "~/lib/dashboard/page-notices"
import type { ContentReviewSession } from "~/lib/dashboard/use-content-review"
import { cn } from "~/lib/utils"

type ReviewSidebarTab = "changes" | "pages"

/**
 * The sidebar of review mode: the review progress, whose counts filter the
 * list, then the changed pages or the whole page tree, which marks each
 * changed page with its dot.
 */
export function ReviewSidebarPanel(props: {
  projectId: string
  session: ContentReviewSession
  canWrite: boolean
  /** Decides on every page of a group. */
  groupDecisions: ReviewGroupDecisions
  onSelect: (href: string) => void
  onFilterChange: (filter: ReviewFilter) => void
  /** The page tree of the review branch. */
  allPages: ReactNode
}) {
  const [tab, setTab] = useState<ReviewSidebarTab>("changes")
  const { review, progress, pages, focusHref, filter } = props.session

  // A filter shows its pages in the Changes list.
  function changeFilter(next: ReviewFilter): void {
    props.onFilterChange(next)
    setTab("changes")
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-3 border-b border-divider px-3 pt-3 pb-2.5">
        {progress.total > 0 ? (
          <ReviewProgressCard progress={progress} filter={filter} onFilterChange={changeFilter} />
        ) : null}
        <ReviewSidebarTabs tab={tab} changeCount={pages.length} onChange={setTab} />
      </div>
      {tab === "changes" ? (
        <nav aria-label="Review pages" className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto pt-1">
          <ReviewChangeList
            pages={pages}
            filter={filter}
            focusHref={focusHref}
            groupDecisions={props.canWrite ? props.groupDecisions : null}
            onSelect={props.onSelect}
            onShowAll={() => props.onFilterChange("all")}
          />
          <ReviewOwnedPages
            projectId={props.projectId}
            flags={review.ownedPageFlags}
            focusHref={focusHref}
            canWrite={props.canWrite}
            onSelect={props.onSelect}
          />
          <ReviewFlaggedPages
            pages={readFlaggedPages(review)}
            focusHref={focusHref}
            onSelect={props.onSelect}
          />
          <ReviewPageNotices
            notices={readPageNotices(review)}
            focusHref={focusHref}
            onSelect={props.onSelect}
          />
        </nav>
      ) : (
        props.allPages
      )}
    </div>
  )
}

const FILTER_STATES: readonly ReviewState[] = ["to_review", "accepted", "rejected"]

/**
 * How far the review is: the reviewed pages, a bar that fills in blue for
 * accepted pages and in gray for rejected ones, so the empty part is the work
 * left, and the count of each state. A count filters the list; a second
 * click shows every page again.
 */
function ReviewProgressCard(props: {
  progress: ReviewProgress
  filter: ReviewFilter
  onFilterChange: (filter: ReviewFilter) => void
}) {
  const { progress } = props
  const counts: Record<ReviewState, number> = {
    to_review: progress.toReview,
    accepted: progress.accepted,
    rejected: progress.rejected,
  }

  return (
    <section aria-label="Review progress" className="flex flex-col gap-2.5 rounded-md border border-border bg-card p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10.5px] tracking-[0.1em] text-label uppercase">Review progress</span>
        <span className="text-xs text-foreground tabular-nums">
          {progress.reviewed} of {progress.total} reviewed
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Reviewed pages"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.reviewed}
        className="flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-divider"
      >
        <span className="bg-primary" style={{ width: share(progress.accepted, progress.total) }} />
        <span className="bg-muted-foreground" style={{ width: share(progress.rejected, progress.total) }} />
      </div>
      <div className="flex flex-col gap-0.5">
        {FILTER_STATES.map((state) => {
          const pressed = props.filter === state
          return (
            <button
              key={state}
              type="button"
              aria-pressed={pressed}
              onClick={() => props.onFilterChange(pressed ? "all" : state)}
              className={cn(
                "flex h-7 items-center gap-2 rounded-sm border px-2 text-left text-[12.5px] transition-colors",
                pressed
                  ? "border-border bg-overlay text-foreground"
                  : "border-transparent text-body hover:bg-overlay hover:text-foreground",
              )}
            >
              <ReviewDecisionMark state={state} />
              <span className="flex-1">{REVIEW_STATE_LABEL[state]}</span>
              <span className="text-muted-foreground tabular-nums">{counts[state]}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

function share(count: number, total: number): string {
  return total === 0 ? "0%" : `${(count / total) * 100}%`
}

function ReviewSidebarTabs(props: {
  tab: ReviewSidebarTab
  changeCount: number
  onChange: (tab: ReviewSidebarTab) => void
}) {
  const tabs: Array<{ value: ReviewSidebarTab; label: string; count?: number }> = [
    { value: "changes", label: "Changes", count: props.changeCount },
    { value: "pages", label: "All pages" },
  ]

  return (
    <div role="tablist" aria-label="Review pages" className="grid grid-cols-2 overflow-hidden rounded-md border border-border">
      {tabs.map(({ value, label, count }) => {
        const selected = props.tab === value
        return (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => props.onChange(value)}
            className={cn(
              "flex items-center justify-center gap-1.5 border-r border-border py-1.5 font-mono text-[10.5px] font-medium tracking-[0.12em] uppercase transition-colors last:border-r-0",
              selected ? "bg-primary-wash text-primary-text" : "text-muted-foreground hover:bg-overlay hover:text-foreground",
            )}
          >
            {label}
            {count !== undefined ? <span className="tabular-nums opacity-70">{count}</span> : null}
          </button>
        )
      })}
    </div>
  )
}
