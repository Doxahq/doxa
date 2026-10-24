import type { GenerationReviewPage } from "@doxahq/contracts/generation-reviews"

import { PAGE_LABEL_CLASS } from "~/components/dashboard/content/content-row-classes"
import {
  ReviewGroupActions,
  type ReviewGroupDecisions,
} from "~/components/dashboard/content/review/review-group-actions"
import { ReviewChangeIcon, ReviewDecisionMark } from "~/components/dashboard/content/review/review-marks"
import {
  duplicateReviewTitles,
  filterReviewPages,
  groupReviewPagesByChange,
  REVIEW_CHANGE_COPY,
  REVIEW_CHANGE_MARK,
  REVIEW_STATE_LABEL,
  reviewState,
  type ReviewChangeGroup,
  type ReviewChangeTone,
  type ReviewFilter,
} from "~/lib/dashboard/generation-review-model"
import { cn } from "~/lib/utils"

const LIST_TITLE: Record<ReviewFilter, string> = {
  all: "All changes",
  to_review: "To review",
  accepted: "Accepted",
  rejected: "Rejected",
}

const TONE_TEXT_CLASS: Record<ReviewChangeTone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
}

/**
 * The pages that the generation changes, in the sidebar, grouped by what the
 * generation did to them: deleted, changed, then new pages. Each row shows
 * that change on the left and the decision on the right. A decided page
 * reads grayed, so the pages that are left stand out. A person who can
 * decide gets two buttons per group, to accept or reject all of its pages.
 * A read-only list, such as the changes of a pull request preview, shows the
 * changes alone: nobody decides on them.
 */
export function ReviewChangeList(props: {
  pages: readonly GenerationReviewPage[]
  filter: ReviewFilter
  focusHref: string | null
  /** Null for a role that cannot decide. */
  groupDecisions: ReviewGroupDecisions | null
  /** True hides the decisions and what is left to review. */
  readOnly?: boolean
  onSelect: (href: string) => void
  onShowAll: () => void
}) {
  if (props.pages.length === 0) {
    return <p className="px-4 py-6 text-center text-xs text-muted-foreground">The generation changed no page.</p>
  }

  const shown = filterReviewPages(props.pages, props.filter)
  const groups = groupReviewPagesByChange(props.pages, shown)
  const duplicates = duplicateReviewTitles(props.pages)

  return (
    <>
      <div className="flex items-center justify-between gap-2 px-4 pt-2">
        <span className="font-mono text-[10.5px] tracking-[0.1em] text-label uppercase">{LIST_TITLE[props.filter]}</span>
        {props.filter !== "all" ? (
          <button type="button" onClick={props.onShowAll} className="px-1 text-[11.5px] text-primary-text hover:underline">
            Show all {props.pages.length}
          </button>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">
          No page is {LIST_TITLE[props.filter].toLowerCase()}.
        </p>
      ) : (
        groups.map((group) =>
          group.pages.length > 0 ? (
            <ReviewChangeGroupSection
              key={group.change}
              group={group}
              duplicates={duplicates}
              focusHref={props.focusHref}
              decisions={props.groupDecisions}
              readOnly={props.readOnly === true}
              onSelect={props.onSelect}
            />
          ) : null,
        )
      )}
    </>
  )
}

function ReviewChangeGroupSection(props: {
  group: ReviewChangeGroup
  duplicates: ReadonlySet<string>
  focusHref: string | null
  decisions: ReviewGroupDecisions | null
  readOnly: boolean
  onSelect: (href: string) => void
}) {
  const { group } = props
  const tag = REVIEW_CHANGE_COPY[group.change].tag

  return (
    <section aria-label={`${tag} pages`} className="pb-1">
      <div className={cn("flex items-center gap-2 px-4", props.decisions ? "pt-2 pb-0.5" : "pt-3 pb-1.5")}>
        <h3 className="flex items-center gap-2">
          <span className={cn("font-mono text-[10.5px] tracking-[0.08em] uppercase", TONE_TEXT_CLASS[REVIEW_CHANGE_MARK[group.change].tone])}>
            {tag}
          </span>
          <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">{group.total}</span>
        </h3>
        {props.readOnly ? null : (
          <span
            className={cn(
              "ml-auto text-[11px]",
              group.toReview > 0 ? "text-body" : "text-muted-foreground",
              props.decisions && "mr-1",
            )}
          >
            {group.toReview > 0 ? `${group.toReview} to review` : "All reviewed"}
          </span>
        )}
        {/*
          The buttons line up with the decision marks of the rows: a row mark
          is centered 23px from the edge (16px padding, half of 14px), and so
          is the last 22px button with this 4px pull (16 - 4 + 11).
        */}
        {props.decisions ? (
          <span className="-mx-1">
            <ReviewGroupActions pages={group.pages} decisions={props.decisions} />
          </span>
        ) : null}
      </div>
      <ul>
        {group.pages.map((page) => (
          <li key={page.href}>
            <ReviewChangeRow
              page={page}
              showPath={props.duplicates.has(page.title)}
              isSelected={page.branchHref === props.focusHref}
              readOnly={props.readOnly}
              onSelect={props.onSelect}
            />
          </li>
        ))}
      </ul>
    </section>
  )
}

/** One review page: what the generation did, its title, and the decision unless the list is read-only. */
function ReviewChangeRow(props: {
  page: GenerationReviewPage
  showPath: boolean
  isSelected: boolean
  readOnly: boolean
  onSelect: (href: string) => void
}) {
  const { page } = props
  const state = reviewState(page)
  const isDecided = !props.readOnly && state !== "to_review"
  const changeLabel = `${REVIEW_CHANGE_MARK[page.change].label} by the generation`

  return (
    <button
      type="button"
      onClick={() => props.onSelect(page.branchHref)}
      aria-current={props.isSelected ? "page" : undefined}
      title={props.readOnly ? changeLabel : `${changeLabel} · ${REVIEW_STATE_LABEL[state]}`}
      className={cn(
        PAGE_LABEL_CLASS,
        "w-full px-4",
        props.isSelected
          ? "bg-primary-wash text-primary-text shadow-[inset_2px_0_0_var(--primary)]"
          : isDecided
            ? "text-muted-foreground hover:bg-overlay hover:text-foreground"
            : "text-foreground hover:bg-overlay",
      )}
    >
      <ReviewChangeIcon change={page.change} />
      <span className={cn("min-w-0 flex-1 truncate text-[13.5px]", !isDecided && "font-medium")}>{page.title}</span>
      {props.showPath ? (
        <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{page.branchHref}</span>
      ) : null}
      {props.readOnly ? null : <ReviewDecisionMark state={state} />}
    </button>
  )
}
