import type { AnyRoute } from "@tanstack/react-router"
import { Loader2 } from "lucide-react"

import { cn } from "~/lib/utils"

/** A small spinner with a mono label: the look of the editor while a page loads. */
export function LoadingLabel({ label, className }: { label: string; className?: string }) {
  return (
    <div
      role="status"
      className={cn("flex items-center justify-center gap-2 p-6 text-muted-foreground", className)}
    >
      <Loader2 aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />
      <span className="font-mono text-[10px] tracking-[0.14em] uppercase">{label}</span>
    </div>
  )
}

/**
 * The main area while a project page loads its code. The sidebar shows the
 * page's view at the same time, and the project layout keeps the top bar.
 */
export function ProjectPagePending() {
  return <LoadingLabel label="Loading page" className="min-h-64 flex-1" />
}

/**
 * The route options that every project page shares. If a page is not ready
 * after `pendingMs`, the router shows `ProjectPagePending` in its place, for
 * at least `pendingMinMs` so that it does not flash. A page that is ready
 * sooner, for example because its code is already loaded, shows at once.
 *
 * Route files spread this into their options. The pending component and the
 * loader are not code split, so the loading view shows without a download.
 */
export const projectPagePending = {
  pendingComponent: ProjectPagePending,
  pendingMs: 150,
  pendingMinMs: 300,
  // The router applies `pendingMinMs` only when it waits on a loader. This
  // loader waits for the page code, so the minimum also applies to a page
  // that loads only code.
  loader: async ({ route }: { route: AnyRoute }) => {
    await route.options.component?.preload?.()
  },
} as const
