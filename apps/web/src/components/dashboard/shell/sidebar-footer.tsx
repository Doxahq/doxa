import { Link, useNavigate } from "@tanstack/react-router"
import { useRef, useState } from "react"
import { BookText, ChevronRight, ChevronsUpDown, Github, LogOut, PanelsTopLeft, UserRound } from "lucide-react"

import { ThemeMenuItem } from "~/components/dashboard/shell/theme-menu-item"
import { UserAvatar } from "~/components/dashboard/shell/user-avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu"
import { useDashboardAuth } from "~/lib/auth/dashboard-auth-context"
import { DOXA_DOCS_URL, DOXA_GITHUB_URL } from "~/lib/dashboard/external-links"
import { useShell } from "~/lib/dashboard/shell-context"


/** Full-width button that slides to the Site settings view. */
export function SiteSettingsButton({ projectId }: { projectId: string }) {
  const { openSiteSettings } = useShell()

  return (
    <button
      type="button"
      onClick={() => openSiteSettings(projectId)}
      className="mb-2 flex w-full items-center gap-2.5 rounded-md border border-border bg-card px-2.5 py-2 text-[13.5px] text-foreground transition-colors hover:border-border-strong hover:bg-surface-hover [&>svg]:size-4"
    >
      <PanelsTopLeft aria-hidden="true" />
      <span>Site settings</span>
      <span className="ml-auto flex items-center text-faint">
        <ChevronRight aria-hidden="true" className="size-3.5" />
      </span>
    </button>
  )
}

/** The widest the account menu gets, in pixels: about the row width at the default sidebar width. */
const ACCOUNT_MENU_MAX_WIDTH = 320

/**
 * Avatar, name and the menu of the person's own account: their email, then
 * Account settings, the theme switch and Sign out. A person with no name
 * shows their email.
 * Workspaces, projects and billing are in the logo menu.
 */
export function UserRow({ showLinks = true }: { showLinks?: boolean }) {
  const navigate = useNavigate()
  const { user, isPending, signOut } = useDashboardAuth()
  // The identity loads in the browser. Until then the row leaves it blank.
  const displayName = user?.name?.trim() || user?.email || (isPending ? "" : "Account")
  const email = user?.email ?? ""
  const showsEmailInMenu = email !== "" && displayName !== email
  // The menu renders in a portal, outside the sidebar, so it cannot read `--sidebar-width`.
  // It takes the width of this row (the sidebar minus its padding) each time it opens,
  // up to ACCOUNT_MENU_MAX_WIDTH, so a wide sidebar does not stretch the short rows.
  const rowRef = useRef<HTMLDivElement>(null)
  const [menuWidth, setMenuWidth] = useState<number>()

  async function handleSignOut() {
    await signOut().catch(() => undefined)
    await navigate({ to: "/login" })
  }

  return (
    <div ref={rowRef} className="flex items-center gap-1.5 pt-1">
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open || !rowRef.current) return
          setMenuWidth(Math.min(rowRef.current.getBoundingClientRect().width, ACCOUNT_MENU_MAX_WIDTH))
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Account menu"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-overlay data-[state=open]:bg-overlay"
          >
            <UserAvatar image={user?.image} name={displayName} className="size-[30px]" />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">{displayName}</span>
            <ChevronsUpDown aria-hidden="true" className="size-3.5 shrink-0 text-faint" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          className="w-64"
          style={menuWidth ? { width: menuWidth } : undefined}
        >
          {showsEmailInMenu ? (
            <>
              <DropdownMenuLabel className="truncate font-normal text-muted-foreground">{email}</DropdownMenuLabel>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem asChild>
            <Link to="/dashboard/settings">
              <UserRound />
              Account settings
            </Link>
          </DropdownMenuItem>
          <ThemeMenuItem />
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void handleSignOut()}>
            <LogOut />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {showLinks ? (
        <>
          <IconLink href={DOXA_GITHUB_URL} label="Doxa on GitHub" icon={Github} />
          <IconLink href={DOXA_DOCS_URL} label="Doxa documentation" icon={BookText} />
        </>
      ) : null}
    </div>
  )
}

function IconLink({
  href,
  label,
  icon: Icon,
}: {
  href: string
  label: string
  icon: typeof Github
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      className="grid size-7 shrink-0 place-items-center text-muted-foreground transition-colors hover:bg-overlay hover:text-foreground"
    >
      <Icon aria-hidden="true" className="size-4" />
    </a>
  )
}
