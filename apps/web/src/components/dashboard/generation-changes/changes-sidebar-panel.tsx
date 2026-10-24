import type { GenerationReviewPage } from "@doxahq/contracts/generation-reviews"

import { ReviewChangeList } from "~/components/dashboard/content/review/review-change-list"
import { ReviewChangeIcon } from "~/components/dashboard/content/review/review-marks"
import { SidebarViewHeader } from "~/components/dashboard/shell/sidebar-view-stack"
import { Skeleton } from "~/components/ui/skeleton"
import { countChangedPages } from "~/lib/dashboard/generation-changes-model"
import { REVIEW_CHANGE_MARK, REVIEW_GROUP_ORDER } from "~/lib/dashboard/generation-review-model"

const SUMMARY_LABEL_CLASS = "font-mono text-[10.5px] tracking-[0.1em] text-label uppercase"

/**
 * The sidebar of the changes of a pull request preview: how many pages each
 * kind of change touches, then the changed pages as the review lists them,
 * without decisions. Null pages draw the loading shape of the same parts.
 */
export function ChangesSidebarPanel(props: {
  /** Null while the changes load. */
  pages: readonly GenerationReviewPage[] | null
  focusHref: string | null
  onSelect: (href: string) => void
  onBack: () => void
}) {
  return (
    <>
      <SidebarViewHeader label="Changes" backLabel="Back to generation" onBack={props.onBack} />
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-divider px-3 pt-3 pb-2.5">
          <ChangesSummary pages={props.pages} />
        </div>
        <nav aria-label="Changed pages" className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto pt-1">
          {props.pages ? (
            <ReviewChangeList
              pages={props.pages}
              filter="all"
              focusHref={props.focusHref}
              groupDecisions={null}
              readOnly
              onSelect={props.onSelect}
              onShowAll={() => undefined}
            />
          ) : (
            <ChangeListSkeleton />
          )}
        </nav>
      </div>
    </>
  )
}

/** The number of changed pages, then one line for each kind of change. */
function ChangesSummary({ pages }: { pages: readonly GenerationReviewPage[] | null }) {
  const counts = pages ? countChangedPages(pages) : null

  return (
    <section aria-label="Changes summary" className="flex flex-col gap-2.5 rounded-md border border-border bg-card p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className={SUMMARY_LABEL_CLASS}>Pull request changes</span>
        {pages ? (
          <span className="text-xs text-foreground tabular-nums">
            {pages.length} {pages.length === 1 ? "page" : "pages"}
          </span>
        ) : (
          <Skeleton className="h-3 w-12 rounded-sm" />
        )}
      </div>
      <ul className="flex flex-col gap-0.5">
        {REVIEW_GROUP_ORDER.map((change) => (
          <li key={change} className="flex h-7 items-center gap-2 px-2 text-[12.5px] text-body">
            <ReviewChangeIcon change={change} />
            <span className="flex-1">{REVIEW_CHANGE_MARK[change].label}</span>
            {counts ? (
              <span className="text-muted-foreground tabular-nums">{counts[change]}</span>
            ) : (
              <Skeleton className="h-3 w-4 rounded-sm" />
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

const SKELETON_ROW_WIDTHS = ["62%", "48%", "70%", "54%", "66%", "40%"]

function ChangeListSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3 px-4 pt-3">
      <span className="sr-only">Loading changed pages</span>
      <Skeleton className="h-3 w-24 rounded-sm" />
      {SKELETON_ROW_WIDTHS.map((width) => (
        <div key={width} className="flex h-6 items-center gap-2.5">
          <Skeleton className="size-4 shrink-0 rounded-sm" />
          <Skeleton className="h-3 rounded-sm" style={{ width }} />
        </div>
      ))}
    </div>
  )
}
