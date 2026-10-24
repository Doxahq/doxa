import type { DocsMdxIssue } from "@doxahq/contracts"
import { AlertTriangle } from "lucide-react"

import { MenuSectionLabel } from "~/components/dashboard/shell/menu-parts"
import { formatIssueLine } from "~/lib/dashboard/mdx-issues"

/**
 * The MDX issues of the open page, under the editor (v2 spec 8.1). The page
 * is saved anyway; the issues only block a publish. With `onSelect`, each
 * issue with a line is a button that shows the line in the source.
 */
export function PageMdxIssues({
  issues,
  onSelect,
}: {
  issues: readonly DocsMdxIssue[]
  onSelect?: (issue: DocsMdxIssue) => void
}) {
  if (issues.length === 0) return null
  return (
    <section
      aria-label="MDX issues"
      className="scrollbar-subtle max-h-40 shrink-0 overflow-y-auto border-t border-danger/40 bg-card"
    >
      <div className="flex items-center gap-2 px-4 pt-2.5 pb-1 sm:px-6">
        <AlertTriangle aria-hidden="true" className="size-3.5 text-danger" />
        <MenuSectionLabel>MDX issues</MenuSectionLabel>
        <span className="font-mono text-[10.5px] text-label">{issues.length}</span>
        <span className="ml-auto text-xs text-muted-foreground">Saved. Fix before you publish.</span>
      </div>
      <ul className="pb-1.5">
        {issues.map((issue, index) => (
          <li key={`${issue.line ?? "none"}:${issue.column ?? "none"}:${index}`}>
            {onSelect && issue.line !== null ? (
              <button
                type="button"
                onClick={() => onSelect(issue)}
                className="flex w-full items-baseline gap-3 px-4 py-1 text-left text-[13px] text-body transition-colors hover:bg-overlay sm:px-6"
              >
                <IssueText issue={issue} />
              </button>
            ) : (
              <div className="flex items-baseline gap-3 px-4 py-1 text-[13px] text-body sm:px-6">
                <IssueText issue={issue} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function IssueText({ issue }: { issue: DocsMdxIssue }) {
  return (
    <>
      <span className="w-24 shrink-0 font-mono text-[11px] text-danger">{formatIssueLine(issue)}</span>
      <span className="min-w-0 flex-1">{issue.message}</span>
    </>
  )
}
