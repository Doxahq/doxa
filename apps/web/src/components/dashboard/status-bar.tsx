import { useRouterState } from "@tanstack/react-router"

import { useDashboardAuth } from "~/lib/auth/dashboard-auth-context"
import { useOptionalProjectBranch } from "~/lib/dashboard/project-branch-context"

/**
 * The terminal bar under the main area: `>_ email:path` on the left, the
 * current branch and system status on the right. It starts where the sidebar
 * ends.
 */
export function StatusBar() {
  const { user, isPending } = useDashboardAuth()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const branch = useOptionalProjectBranch()

  // The identity loads in the browser. Until then the bar leaves it blank.
  const email = isPending ? "" : user?.email?.toLowerCase() || "guest"
  const page = pageLabel(pathname)
  const branchName = branch ? (branch.selectedBranch?.name ?? "main") : null

  return (
    <footer className="flex h-(--status-bar-height) shrink-0 items-center justify-between gap-3 overflow-hidden border-t border-border bg-sidebar px-5 font-mono text-[11px] tracking-[0.04em] whitespace-nowrap text-muted-foreground">
      <span className="flex min-w-0 items-center gap-1.5 truncate">
        <span className="text-label">{">_"}</span>
        <span className="truncate">
          {email}
          <span className="text-label">:</span>
          <span className="text-body">{page}</span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-4.5">
        {branchName ? <span className="max-[820px]:hidden">branch: {branchName}</span> : null}
        <span className="flex items-center gap-1.5 tracking-[0.12em] uppercase">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
          All systems operational
        </span>
      </span>
    </footer>
  )
}

function pageLabel(pathname: string): string {
  const segments = pathname.replace(/^\/dashboard\/?/, "").split("/").filter(Boolean)
  if (segments.length === 0) return "overview"
  return segments.join("/")
}
