import { lazy, Suspense } from "react"
import { useQuery } from "@tanstack/react-query"
import type { BranchRef, DocsBranchPageDiff } from "@doxahq/contracts/docs-branches"
import { ArrowLeft, X } from "lucide-react"

import { LoadingLabel } from "~/components/dashboard/route-pending"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { FILE_CHANGE_BADGE } from "~/lib/dashboard/branch-diff-model"
import { getErrorMessage } from "~/lib/errors"
import { docsBranchPageSourcesQueryOptions } from "~/lib/queries/docs-branches"

// CodeMirror's merge view loads only when a diff opens.
const MdxMergeView = lazy(() => import("~/components/code-editor/mdx-merge-view"))

export type PageDiffTarget = Pick<DocsBranchPageDiff, "href" | "title" | "change">

/**
 * The Split pane in diff mode (v2 spec 6.2, 12 q5): the page source on main
 * on the left and on the branch on the right, read-only. Close returns to
 * the normal Split panes.
 */
export function BranchPageDiffPane(props: {
  projectId: string
  branch: BranchRef
  branchName: string
  page: PageDiffTarget
  onClose: () => void
  /** Reopens the agent's request in the publish menu. */
  onBackToRequest?: () => void
}) {
  const sources = useQuery(docsBranchPageSourcesQueryOptions(props.projectId, props.branch, props.page.href))
  const badge = FILE_CHANGE_BADGE[props.page.change]

  return (
    <section aria-label={`Diff of ${props.page.title}`} className="flex min-h-0 flex-1 flex-col border-t border-border bg-card">
      <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-border px-4 py-2.5">
        <span className="font-mono text-[10.5px] font-bold tracking-[0.14em] text-label uppercase">Diff</span>
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{props.page.title}</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">{props.page.href}</span>
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <span className="ml-auto flex items-center gap-2">
          {props.onBackToRequest ? (
            <Button type="button" variant="outline" size="sm" onClick={props.onBackToRequest}>
              <ArrowLeft aria-hidden="true" />
              Back to request
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="sm" onClick={props.onClose}>
            <X aria-hidden="true" />
            Close diff
          </Button>
        </span>
      </div>
      <div className="grid shrink-0 grid-cols-2 border-b border-divider font-mono text-[10.5px] tracking-[0.1em] text-label uppercase">
        <span className="truncate border-r border-divider px-4 py-1.5">main</span>
        <span className="truncate px-4 py-1.5">{props.branchName}</span>
      </div>
      <div className="min-h-0 flex-1">
        {sources.isPending ? (
          <LoadingLabel label="Loading diff" className="h-full flex-1" />
        ) : sources.error ? (
          <p className="px-4 py-3 text-sm text-destructive">
            {getErrorMessage(sources.error, "The diff could not be loaded.")}
          </p>
        ) : (
          <Suspense fallback={<LoadingLabel label="Loading diff" className="h-full flex-1" />}>
            <MdxMergeView before={sources.data.before ?? ""} after={sources.data.after ?? ""} />
          </Suspense>
        )}
      </div>
    </section>
  )
}
