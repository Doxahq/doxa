import type { FlaggedPage } from "@doxahq/contracts/generation-reviews"

import { SECTION_LABEL_CLASS } from "~/components/dashboard/content/content-row-classes"
import { FLAGGED_PAGE_OUTCOME_LABEL } from "~/lib/dashboard/flagged-pages"
import { cn } from "~/lib/utils"

/**
 * Pages that the run could not write. A page that kept its published
 * version opens like any page; a page that is not in the version is only
 * listed, with the reason in its tooltip.
 */
export function ReviewFlaggedPages(props: {
  pages: readonly FlaggedPage[]
  focusHref: string | null
  onSelect: (href: string) => void
}) {
  if (props.pages.length === 0) return null

  return (
    <section aria-label="Pages the run could not write" className="border-t border-divider pt-1 pb-2">
      <h3 className={cn(SECTION_LABEL_CLASS, "px-4 text-label")}>
        Could not be written
        <span className="text-faint">{props.pages.length}</span>
      </h3>
      <ul>
        {props.pages.map((page) => {
          const label = (
            <>
              <span className="truncate text-[13.5px]">{page.title}</span>
              <span className="truncate font-mono text-[10.5px] text-faint">
                {FLAGGED_PAGE_OUTCOME_LABEL[page.outcome]}
              </span>
            </>
          )
          const href = page.href
          if (!href) {
            return (
              <li key={page.pageId} title={page.reason} className="flex min-w-0 flex-col py-1.5 pr-2 pl-4 text-muted-foreground">
                {label}
              </li>
            )
          }
          const isSelected = href === props.focusHref
          return (
            <li
              key={page.pageId}
              className={cn(isSelected ? "bg-primary-wash shadow-[inset_2px_0_0_var(--primary)]" : "hover:bg-overlay")}
            >
              <button
                type="button"
                onClick={() => props.onSelect(href)}
                aria-current={isSelected ? "page" : undefined}
                title={page.reason}
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
