import { Fragment, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { Copy, ExternalLink, MoreHorizontal, PanelLeft } from "lucide-react"
import { toast } from "sonner"

import { MenuSectionLabel } from "~/components/dashboard/shell/menu-parts"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu"
import { useSidebar } from "~/components/ui/sidebar"
import { useWorkspaceCrumb } from "~/lib/dashboard/workspace-context"
import { projectDetailQueryOptions } from "~/lib/queries/dashboard"
import { cn } from "~/lib/utils"

export const TOP_BAR_ICON_BUTTON_CLASS =
  "grid size-7 shrink-0 place-items-center text-muted-foreground transition-colors hover:bg-overlay hover:text-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-overlay data-[state=open]:text-foreground [&_svg]:size-4"

/**
 * The 52px bar above the main area: sidebar toggle, breadcrumb, an optional
 * status (the editor's save state), then actions and the "more" menu. On a
 * page of one workspace, the breadcrumb starts with the workspace name.
 */
export function TopBar({
  crumbs,
  status,
  actions,
  menu,
}: {
  /** Breadcrumb labels. The last one is the current item. */
  crumbs: readonly string[]
  status?: ReactNode
  actions?: ReactNode
  menu?: ReactNode
}) {
  const workspaceCrumb = useWorkspaceCrumb()
  const trail = workspaceCrumb ? [workspaceCrumb, ...crumbs] : crumbs
  return (
    <header className="sticky top-0 z-20 flex h-13 shrink-0 items-center gap-3 border-b border-border bg-background pr-3.5 pl-3">
      <SidebarToggle className="size-8" />
      <nav aria-label="Breadcrumb" className="min-w-0 overflow-hidden">
        <ol className="flex min-w-0 items-center gap-1.5 text-[13px] whitespace-nowrap text-muted-foreground">
          {trail.map((crumb, index) => {
            const isCurrent = index === trail.length - 1
            return (
              <Fragment key={`${index}:${crumb}`}>
                {index > 0 ? (
                  <li aria-hidden="true" className="text-faint max-[1280px]:hidden">/</li>
                ) : null}
                <li
                  aria-current={isCurrent ? "page" : undefined}
                  className={cn(
                    "truncate",
                    isCurrent ? "font-medium text-foreground" : "max-w-40 max-[1280px]:hidden",
                  )}
                >
                  {crumb}
                </li>
              </Fragment>
            )
          })}
        </ol>
      </nav>
      {/* A little room after the breadcrumb keeps the page title the first thing read. */}
      {status ? <div className="ml-2 flex shrink-0 items-center">{status}</div> : null}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {actions}
        {menu}
      </div>
    </header>
  )
}

/**
 * The top bar of an account page: "Account / Account settings". A billing
 * page names its workspace instead ("Coder One / Billing / Plan and
 * invoices"), when the viewer has more than one.
 */
export function AccountTopBar({ crumbs }: { crumbs: readonly string[] }) {
  const workspaceCrumb = useWorkspaceCrumb()
  return <TopBar crumbs={workspaceCrumb ? crumbs : ["Account", ...crumbs]} />
}

/** Opens and closes the sidebar. On mobile it opens the drawer. */
export function SidebarToggle({ className }: { className?: string }) {
  const { toggleSidebar, open, isMobile, openMobile } = useSidebar()
  const expanded = isMobile ? openMobile : open
  return (
    <button
      type="button"
      onClick={toggleSidebar}
      aria-label={expanded ? "Hide sidebar (⌘\\)" : "Show sidebar (⌘\\)"}
      aria-expanded={expanded}
      title="Toggle sidebar (⌘\)"
      className={cn(TOP_BAR_ICON_BUTTON_CLASS, className)}
    >
      <PanelLeft aria-hidden="true" />
    </button>
  )
}

/** The three-dots menu in the top bar. */
export function MoreMenu({ children }: { children: ReactNode }) {
  return (
    // Items here open dialogs (for example "Discard all changes"). A modal menu
    // sets `pointer-events: none` on the body, and a dialog opened from it
    // restores that value when it closes, which freezes the page. A menu that
    // is not modal never sets the style. See content-row-actions.tsx.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="More actions" title="More" className={TOP_BAR_ICON_BUTTON_CLASS}>
          <MoreHorizontal aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 p-1.5">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Small uppercase label for a group inside a menu. */
export function MoreMenuLabel({ children }: { children: ReactNode }) {
  return (
    <DropdownMenuLabel className="px-2.5 pt-2 pb-1.5">
      <MenuSectionLabel>{children}</MenuSectionLabel>
    </DropdownMenuLabel>
  )
}

/** SITE group: open the published docs and copy the site URL. */
export function SiteMenuItems({ projectId }: { projectId: string }) {
  const detail = useQuery(projectDetailQueryOptions(projectId))
  const docsUrl = detail.data?.project.publishedVersionId ? detail.data.project.docsUrl : null

  async function copyUrl() {
    if (!docsUrl) return
    try {
      await navigator.clipboard.writeText(docsUrl)
      toast.success("Site URL copied")
    } catch {
      toast.error("The site URL could not be copied.")
    }
  }

  return (
    <>
      <MoreMenuLabel>Site</MoreMenuLabel>
      <DropdownMenuItem
        disabled={!docsUrl}
        onSelect={() => {
          if (docsUrl) window.open(docsUrl, "_blank", "noopener,noreferrer")
        }}
      >
        <ExternalLink aria-hidden="true" />
        Open published docs
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!docsUrl} onSelect={() => void copyUrl()}>
        <Copy aria-hidden="true" />
        Copy site URL
      </DropdownMenuItem>
    </>
  )
}
