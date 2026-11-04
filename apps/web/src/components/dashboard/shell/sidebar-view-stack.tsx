import type { ReactNode } from "react"
import { ArrowLeft } from "lucide-react"

import { SIDEBAR_VIEWS, useShell, type SidebarView } from "~/lib/dashboard/shell-context"
import { cn } from "~/lib/utils"

/**
 * The sidebar body: one panel per view, side by side in the order Project,
 * Content, Site settings. Moving right slides in from the right, going back
 * slides in from the left. Only the panel being left and the panel being
 * entered animate, so a third panel never sweeps across. Hidden panels are
 * inert, so focus and screen readers skip them.
 */
export function SidebarViewStack({ views }: { views: Record<SidebarView, ReactNode> }) {
  const { view, previousView } = useShell()
  const currentIndex = SIDEBAR_VIEWS.indexOf(view)

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      {SIDEBAR_VIEWS.map((panel, index) => {
        const isCurrent = panel === view
        const animates = isCurrent || panel === previousView
        return (
          <div
            key={panel}
            inert={!isCurrent}
            aria-hidden={!isCurrent}
            data-sidebar-view={panel}
            className={cn(
              "absolute inset-0 flex flex-col bg-sidebar",
              animates
                ? "transition-[transform,opacity] duration-[340ms] ease-[cubic-bezier(0.22,0.8,0.2,1)] motion-reduce:transition-none"
                : "transition-none",
              index < currentIndex && "-translate-x-full opacity-0",
              index > currentIndex && "translate-x-full opacity-0",
            )}
          >
            {views[panel]}
          </div>
        )
      })}
    </div>
  )
}

/** Footer area at the bottom of a sidebar view. */
export function SidebarViewFooter({ children }: { children: ReactNode }) {
  return <div className="shrink-0 border-t border-divider px-2 pt-1.5 pb-2">{children}</div>
}

/** Back arrow and uppercase label at the top of a nested view. */
export function SidebarViewHeader({
  label,
  backLabel,
  onBack,
  children,
}: {
  label: string
  backLabel: string
  onBack: () => void
  children?: ReactNode
}) {
  return (
    <div className="flex shrink-0 flex-col gap-2.5 border-b border-divider px-3 py-2.5">
      <button
        type="button"
        onClick={onBack}
        aria-label={backLabel}
        title={backLabel}
        className="-ml-1 flex h-7 w-fit max-w-full items-center gap-1.5 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-overlay hover:text-foreground [&_svg]:size-4 [&_svg]:shrink-0"
      >
        <ArrowLeft aria-hidden="true" />
        <span className="truncate font-mono text-[11px] font-medium tracking-[0.16em] text-foreground uppercase">
          {label}
        </span>
      </button>
      {children}
    </div>
  )
}

