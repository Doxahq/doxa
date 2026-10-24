import { PreviewSkeleton, SourceSkeleton } from "~/components/dashboard/content/editor-skeleton"
import { Skeleton } from "~/components/ui/skeleton"

/** The changed page while the list loads: the bar, then the source and the render. */
export function ChangedPageSkeleton() {
  return (
    <section aria-busy="true" className="flex min-h-0 flex-1 flex-col border-t border-border">
      <div className="flex shrink-0 flex-col gap-2.5 border-b border-border bg-card px-5 py-4">
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-5 rounded-sm" />
          <Skeleton className="h-5 w-48 rounded-sm" />
        </div>
        <Skeleton className="h-3.5 w-80 max-w-full rounded-sm" />
      </div>
      <div className="flex min-h-0 flex-1 flex-row max-[820px]:flex-col">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-border max-[820px]:border-r-0 max-[820px]:border-b">
          <SourceSkeleton />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-sidebar">
          <PreviewSkeleton />
        </div>
      </div>
    </section>
  )
}
