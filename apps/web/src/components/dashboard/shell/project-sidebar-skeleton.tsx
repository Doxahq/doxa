import type { ComponentType } from "react"
import { Activity, Bot, ChevronRight, Info, PanelsTopLeft, PenLine, Settings } from "lucide-react"

import { BetaTag } from "~/components/dashboard/beta-tag"
import { DoxabotIcon } from "~/components/dashboard/doxabot/doxabot-icon"
import { UserRow } from "~/components/dashboard/shell/sidebar-footer"
import { SIDEBAR_NAV_ITEM_CLASS } from "~/components/dashboard/shell/sidebar-nav"
import { SidebarViewFooter } from "~/components/dashboard/shell/sidebar-view-stack"
import { Bar, TextBar } from "~/components/dashboard/skeletons/skeleton-kit"
import { useSkeletonPulse } from "~/lib/dashboard/skeleton-pulse"
import { cn } from "~/lib/utils"

interface SkeletonNavItem {
  icon: ComponentType<{ className?: string }>
  label: string
  active?: boolean
  hint?: "chevron" | "beta"
}

/** The rows of `ProjectSidebarView`, in its order. Keep the two lists the same. */
const NAV_ITEMS: readonly SkeletonNavItem[] = [
  { icon: Info, label: "Overview", active: true },
  { icon: PenLine, label: "Content", hint: "chevron" },
  { icon: Activity, label: "Generations" },
  { icon: DoxabotIcon, label: "Doxabot", hint: "beta" },
  { icon: Bot, label: "Requests" },
  { icon: Settings, label: "Settings" },
]

/**
 * The Project view of the sidebar while the dashboard opens a project from
 * `/dashboard`, before the project is known.
 *
 * It draws what needs no data with the real classes of `ProjectSidebarView`:
 * the rows, their icons and labels, Overview as the current page, the static
 * hints, the Site settings button and the account row. Only the project title
 * is a bar. Every box has the size and place of the real one, so nothing
 * moves when the real view replaces it. The rows are not links yet, so they
 * take no hover fill and no pointer.
 */
export function ProjectSidebarSkeleton() {
  const ref = useSkeletonPulse<HTMLDivElement>()
  return (
    // A box for the shimmer clock that adds nothing to the layout.
    <div ref={ref} style={{ display: "contents" }}>
      <nav
        aria-label="Project"
        aria-busy="true"
        inert
        className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-3.5"
      >
        {/* ProjectTitleSelect: the monogram and the name. */}
        <div className="pt-2 pb-0.5">
          <div className="flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-1 text-base leading-7 font-semibold tracking-[-0.01em]">
            <Bar width="22px" height="22px" className="rounded-md" />
            <TextBar width="58%" className="min-w-0 flex-1" />
          </div>
        </div>
        {NAV_ITEMS.map(({ icon: Icon, label, active, hint }) => (
          <div
            key={label}
            className={cn(
              SIDEBAR_NAV_ITEM_CLASS,
              active ? "bg-sidebar-active text-foreground shadow-(--sidebar-active-shadow)" : "text-body",
            )}
          >
            <Icon aria-hidden="true" />
            <span className="min-w-0 truncate">{label}</span>
            {hint ? (
              <span className="ml-auto flex items-center gap-1.5">
                {hint === "beta" ? <BetaTag /> : <ChevronRight aria-hidden="true" className="size-3.5 text-faint" />}
              </span>
            ) : null}
          </div>
        ))}
      </nav>
      <SidebarViewFooter>
        {/* SiteSettingsButton, without its hover fill: it opens nothing yet. */}
        <div
          aria-hidden="true"
          className="mb-2 flex w-full items-center gap-2.5 rounded-md border border-border bg-card px-2.5 py-2 text-[13.5px] text-foreground [&>svg]:size-4"
        >
          <PanelsTopLeft aria-hidden="true" />
          <span>Site settings</span>
          <span className="ml-auto flex items-center text-faint">
            <ChevronRight aria-hidden="true" className="size-3.5" />
          </span>
        </div>
        <UserRow />
      </SidebarViewFooter>
    </div>
  )
}
