import type { FlaggedPage } from "@doxahq/contracts/generation-reviews"
import { AlertTriangle } from "lucide-react"

import { FLAGGED_PAGE_OUTCOME_LABEL, flaggedPagesHeading } from "~/lib/dashboard/flagged-pages"

/**
 * The pages that the run could not write after its retries. The run still
 * ended with the other pages; each of these kept its published version or
 * is not in the version.
 */
export function GenerationFlaggedPages(props: { pages: readonly FlaggedPage[] }) {
  if (props.pages.length === 0) return null

  return (
    <section aria-label="Flagged pages" className="flex flex-col gap-3 rounded-md border border-warning/35 bg-warning/10 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-warning" />
        {flaggedPagesHeading(props.pages.length)}
      </div>
      <ul className="flex flex-col gap-2">
        {props.pages.map((page) => (
          <li key={page.pageId} className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
            <span className="shrink-0 text-[13.5px] text-foreground">{page.title}</span>
            <span className="shrink-0 font-mono text-[10.5px] tracking-[0.08em] text-label uppercase">
              {FLAGGED_PAGE_OUTCOME_LABEL[page.outcome]}
            </span>
            <span className="min-w-0 break-words text-xs text-muted-foreground sm:truncate" title={page.reason}>
              {page.reason}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
