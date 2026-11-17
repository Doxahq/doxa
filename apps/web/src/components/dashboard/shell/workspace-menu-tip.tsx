import { useEffect, useSyncExternalStore, type ReactNode } from "react"

import { Button } from "~/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent } from "~/components/ui/popover"
import { useSidebar } from "~/components/ui/sidebar"
import { usePageSettled } from "~/lib/dashboard/use-page-settled"
import { useWorkspace } from "~/lib/dashboard/workspace-context"
import {
  markWorkspaceMenuTipSeen,
  readWorkspaceMenuTipSeen,
  subscribeWorkspaceStorage,
} from "~/lib/dashboard/workspace-storage"

const TIP_WIDTH_PX = 240

/** True in the server render, so the tip never shows before the browser storage is read. */
function useTipSeen(): boolean {
  return useSyncExternalStore(subscribeWorkspaceStorage, readWorkspaceMenuTipSeen, () => true)
}

/**
 * A one-time tip under the logo: workspaces, New project and Billing moved
 * into the logo menu. It shows once the page settles, to a person with a
 * project, while the sidebar is open. "Show me" opens the menu; either
 * button, or opening the menu, closes the tip for good.
 */
export function WorkspaceMenuTip({ children }: { children: ReactNode }) {
  const { current, isMenuOpen, setMenuOpen } = useWorkspace()
  const { open: isSidebarOpen, isMobile } = useSidebar()
  const isSettled = usePageSettled()
  const seen = useTipSeen()
  const hasProject = current !== null && current.projectCount > 0
  const isOpen = !seen && isSettled && hasProject && isSidebarOpen && !isMobile && !isMenuOpen

  // A person who found the menu on their own needs no tip.
  useEffect(() => {
    if (!seen && isMenuOpen) markWorkspaceMenuTipSeen()
  }, [seen, isMenuOpen])

  return (
    <Popover
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) markWorkspaceMenuTipSeen()
      }}
    >
      <PopoverAnchor asChild>
        <div className="w-fit">{children}</div>
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={10}
        aria-labelledby="workspace-menu-tip-title"
        // The tip must not take the focus from the page the person opened.
        onOpenAutoFocus={(event) => event.preventDefault()}
        // A near-square card under the logo. The width is inline, so it never depends on a new utility class.
        style={{ width: TIP_WIDTH_PX }}
        className="flex flex-col gap-2 p-3.5"
      >
        <span className="font-mono text-[10.5px] font-medium tracking-[0.16em] text-primary-text uppercase">New</span>
        <span id="workspace-menu-tip-title" className="text-sm font-semibold text-foreground">
          Your workspaces are under the logo
        </span>
        <p className="text-[13px] leading-5 text-muted-foreground">
          Click the Doxa logo to switch between Personal and your teams. New project, Invite members and Billing are
          there too.
        </p>
        <div className="flex gap-1.5 pt-1">
          <Button
            size="sm"
            onClick={() => {
              markWorkspaceMenuTipSeen()
              setMenuOpen(true)
            }}
          >
            Show me
          </Button>
          <Button size="sm" variant="ghost" onClick={markWorkspaceMenuTipSeen}>
            Got it
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
