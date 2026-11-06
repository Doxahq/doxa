import type { PageNotice } from "@doxahq/contracts/generation-reviews"

import { SECTION_LABEL_CLASS } from "~/components/dashboard/content/content-row-classes"
import { pageNoticeDetail, pageNoticeSummary } from "~/lib/dashboard/page-notices"
import { cn } from "~/lib/utils"

/**
 * Pages that the run wrote with issues the writer could not fix, or that
 * runs stopped bringing up to the current instructions. Each one opens like
 * any page; its tooltip lists the issues.
 */
export function ReviewPageNotices(props: {
  notices: readonly PageNotice[]
  focusHref: string | null
  onSelect: (href: string) => void
}) {
  if (props.notices.length === 0) return null

  return (
    <section aria-label="Pages to check" className="border-t border-divider pt-1 pb-2">
      <h3 className={cn(SECTION_LABEL_CLASS, "px-4 text-label")}>
        Check these pages
        <span className="text-faint">{props.notices.length}</span>
      </h3>
      <ul>
        {props.notices.map((notice) => {
          const detail = pageNoticeDetail(notice)
          const label = (
            <>
              <span className="truncate text-[13.5px]">{notice.title}</span>
              <span className="truncate font-mono text-[10.5px] text-faint">{pageNoticeSummary(notice)}</span>
            </>
          )
          const href = notice.href
          if (!href) {
            return (
              <li
                key={`${notice.kind}:${notice.pageId}`}
                title={detail}
                className="flex min-w-0 flex-col py-1.5 pr-2 pl-4 text-muted-foreground"
              >
                {label}
              </li>
            )
          }
          const isSelected = href === props.focusHref
          return (
            <li
              key={`${notice.kind}:${notice.pageId}`}
              className={cn(isSelected ? "bg-primary-wash shadow-[inset_2px_0_0_var(--primary)]" : "hover:bg-overlay")}
            >
              <button
                type="button"
                onClick={() => props.onSelect(href)}
                aria-current={isSelected ? "page" : undefined}
                title={detail}
                className={cn(
                  "flex w-full min-w-0 flex-col py-1.5 pr-2 pl-4 text-left",
                  isSelected ? "text-primary-text" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
