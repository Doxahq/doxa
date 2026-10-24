import { useEffect, useRef, useState } from "react"
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import type { DocsPublication } from "@doxahq/contracts/docs-branches"
import { RotateCcw } from "lucide-react"
import { toast } from "sonner"

import { ApiRequestError } from "~/lib/api-errors"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet"
import { getErrorMessage } from "~/lib/errors"
import { useDialogFocusReturn } from "~/lib/dashboard/use-dialog-focus-return"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"
import {
  docsBranchQueryKeys,
  docsPublicationHistoryQueryOptions,
} from "~/lib/queries/docs-branches"
import { restoreDocsPublication } from "~/lib/docs-branches-api"

export function HistoryPanel(props: {
  projectId: string
  mainVersionId: string | null
  /** False for a role without `docs.restore`: the history is read-only. */
  canRestore?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const focusReturn = useDialogFocusReturn()
  const history = useInfiniteQuery({
    ...docsPublicationHistoryQueryOptions(props.projectId),
    enabled: props.open,
  })
  const [pendingRestore, setPendingRestore] = useState<DocsPublication | null>(null)
  const publications = history.data?.pages.flatMap((page) => page.publications) ?? []

  const restoreMutation = useMutation({
    mutationFn: async (publication: DocsPublication) => {
      if (!props.mainVersionId) throw new Error("The current live version is unavailable.")
      return restoreDocsPublication(props.projectId, publication.id, props.mainVersionId)
    },
    onSuccess: async (_result, publication) => {
      setPendingRestore(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: docsBranchQueryKeys.project(props.projectId) }),
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.contentRoot(props.projectId) }),
      ])
      toast.success(`The publication from ${publishedAt(publication)} is live again.`)
    },
    onError: (error) => {
      if (
        error instanceof ApiRequestError
        && error.status === 409
        && (error.code === "main_changed" || error.code === "branch_behind")
      ) {
        void queryClient.invalidateQueries({
          queryKey: docsBranchQueryKeys.statusRoot(props.projectId),
        })
      }
    },
  })

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-lg" {...focusReturn}>
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle className="font-mono uppercase">Publication history</SheetTitle>
          <SheetDescription>Newest publications appear first.</SheetDescription>
        </SheetHeader>
        <div className="scrollbar-subtle flex-1 space-y-3 overflow-y-auto p-5">
          {history.isPending ? <p className="text-sm text-muted-foreground">Loading history…</p> : null}
          {history.error ? (
            <p className="text-sm text-destructive" role="alert">
              {getErrorMessage(history.error, "The publication history could not be loaded.")}
            </p>
          ) : null}
          {publications.map((publication) => (
            <PublicationCard
              key={publication.id}
              publication={publication}
              onRestore={props.canRestore === false ? null : () => setPendingRestore(publication)}
            />
          ))}
          <HistorySentinel
            enabled={Boolean(history.hasNextPage && !history.isFetchingNextPage)}
            onVisible={() => void history.fetchNextPage()}
          />
          {history.hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => void history.fetchNextPage()}
              disabled={history.isFetchingNextPage}
            >
              {history.isFetchingNextPage ? "Loading more…" : "Load more"}
            </Button>
          ) : null}
          {history.isFetchingNextPage ? <p className="text-sm text-muted-foreground">Loading more…</p> : null}
        </div>
        {pendingRestore ? (
          <SheetFooter className="border-t border-border bg-muted/10">
            <p className="text-sm leading-6">
              Restore the publication from {publishedAt(pendingRestore)}? The live site changes at once.
              {" "}Every branch will need a synchronization.
            </p>
            {restoreMutation.error ? (
              <p className="text-sm text-destructive" role="alert">
                {getErrorMessage(restoreMutation.error, "The publication could not be restored.")}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setPendingRestore(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => restoreMutation.mutate(pendingRestore)}
                disabled={restoreMutation.isPending}
              >
                {restoreMutation.isPending ? "Restoring…" : "Restore now"}
              </Button>
            </div>
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function PublicationCard(props: {
  publication: DocsPublication
  onRestore: (() => void) | null
}) {
  const { publication } = props
  return (
    <article className="rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-bold uppercase">{publication.kind}</span>
            {publication.isCurrent ? <Badge variant="success">Live</Badge> : null}
            {publication.noLongerRestorable ? <Badge variant="muted">No longer restorable</Badge> : null}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {publicationAuthor(publication)}
            {publication.branchName ? ` · ${publication.branchName}` : ""}
            {` · ${publishedAt(publication)}`}
          </p>
        </div>
        {publication.canRestore && props.onRestore ? (
          <Button type="button" variant="outline" size="sm" onClick={props.onRestore}>
            <RotateCcw aria-hidden="true" />
            Restore
          </Button>
        ) : null}
      </div>
      {publication.summary.pageTitles?.length ? (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          {publication.summary.pageTitles.join(", ")}
        </p>
      ) : null}
    </article>
  )
}

function publishedAt(publication: DocsPublication): string {
  return new Date(publication.createdAt).toLocaleString()
}

function HistorySentinel(props: { enabled: boolean; onVisible: () => void }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const target = ref.current
    if (!props.enabled || !target || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) props.onVisible()
    })
    observer.observe(target)
    return () => observer.disconnect()
  }, [props.enabled, props.onVisible])

  return <div ref={ref} aria-hidden="true" className="h-px" />
}

/** "Claude Code, approved by Ada" when an agent published; else the person. */
function publicationAuthor(publication: DocsPublication): string {
  const person = publication.actor?.name ?? "System"
  if (!publication.agent) return person
  return publication.agent.approvalRequestId
    ? `${publication.agent.clientName}, approved by ${person}`
    : publication.agent.clientName
}
