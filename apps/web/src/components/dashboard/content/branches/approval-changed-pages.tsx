import { useQuery } from "@tanstack/react-query"
import type { BranchRef, DocsBranchPageDiff } from "@doxahq/contracts/docs-branches"
import { FileDiff, FileText } from "lucide-react"

import { plural } from "~/components/dashboard/content/branches/publish-menu-parts"
import { MenuSectionLabel } from "~/components/dashboard/shell/menu-parts"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Skeleton } from "~/components/ui/skeleton"
import { FILE_CHANGE_BADGE, otherChangeCount } from "~/lib/dashboard/branch-diff-model"
import { getErrorMessage } from "~/lib/errors"
import { docsBranchDiffQueryOptions } from "~/lib/queries/docs-branches"

/**
 * The changed pages of an agent's publish request, from the branch diff.
 * Each page is marked added, edited or deleted, and its Diff button opens
 * the page source against main in the editor.
 */
export function ApprovalChangedPages(props: {
  projectId: string
  branch: BranchRef
  onOpenPageDiff: (page: DocsBranchPageDiff) => void
}) {
  const diff = useQuery(docsBranchDiffQueryOptions(props.projectId, props.branch))
  const pages = diff.data?.pages ?? []
  const others = diff.data ? otherChangeCount(diff.data) : 0
  const images = diff.data?.assets.length ?? 0

  return (
    <>
      <div className="flex items-baseline justify-between px-5 pt-3.5 pb-1.5">
        <MenuSectionLabel>Changed pages</MenuSectionLabel>
        {diff.data ? <span className="font-mono text-[10.5px] text-label">{pages.length}</span> : null}
      </div>
      <div className="scrollbar-subtle mx-2 mb-2 max-h-72 overflow-y-auto">
        {diff.isPending ? (
          <div className="grid gap-2 px-3 py-2">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        ) : diff.error ? (
          <p className="px-3 py-1.5 text-[13px] text-destructive">
            {getErrorMessage(diff.error, "The changes could not be loaded.")}
          </p>
        ) : pages.length > 0 ? (
          <ul aria-label="Changed pages">
            {pages.map((page) => (
              <ChangedPageRow key={page.href} page={page} onOpenDiff={() => props.onOpenPageDiff(page)} />
            ))}
          </ul>
        ) : (
          <p className="px-3 py-1.5 text-[13px] text-muted-foreground">No page content changed.</p>
        )}
        {others > 0 ? (
          <p className="px-3 pt-1 pb-1.5 text-xs text-muted-foreground">
            Also {plural(others, "structure or site settings change")}.
          </p>
        ) : null}
        {images > 0 ? (
          <p className="px-3 pt-1 pb-1.5 text-xs text-muted-foreground">
            Adds or replaces {plural(images, "image")}.
          </p>
        ) : null}
      </div>
    </>
  )
}

function ChangedPageRow({ page, onOpenDiff }: { page: DocsBranchPageDiff; onOpenDiff: () => void }) {
  const badge = FILE_CHANGE_BADGE[page.change]
  return (
    <li className="flex items-center gap-2.5 py-1.5 pr-1 pl-3 text-sm text-foreground">
      <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{page.title}</span>
      <span className="max-w-[35%] shrink-0 truncate font-mono text-[11px] text-muted-foreground">{page.href}</span>
      <Badge variant={badge.variant} className="shrink-0">{badge.label}</Badge>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2"
        aria-label={`Show the diff of ${page.title}`}
        onClick={onOpenDiff}
      >
        <FileDiff aria-hidden="true" />
        Diff
      </Button>
    </li>
  )
}
