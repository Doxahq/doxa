import { Link, useNavigate } from "@tanstack/react-router"
import { BookText, Check, ChevronRight, ChevronsUpDown, Github, LogOut, PanelsTopLeft, Plus, UserRound, Users } from "lucide-react"

import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu"
import { MenuSectionLabel } from "~/components/dashboard/shell/menu-parts"
import { ProjectMonogram } from "~/components/dashboard/shell/project-monogram"
import { useDashboardAuth } from "~/lib/auth/dashboard-auth-context"
import { DOXA_DOCS_URL, DOXA_GITHUB_URL } from "~/lib/dashboard/external-links"
import { useShell } from "~/lib/dashboard/shell-context"
import { groupProjectsByTeam, hasTeamProjects } from "~/lib/dashboard/teams-model"
import { useProjectsSummary } from "~/lib/dashboard/use-projects-summary"


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

/**
 * Avatar, email and account menu, plus GitHub and docs links. The menu also
 * switches projects and starts a new one.
 */
export function UserRow({ projectId, showLinks = true }: { projectId: string | null; showLinks?: boolean }) {
  const navigate = useNavigate()
  const { user, isPending, signOut } = useDashboardAuth()
  // The identity loads in the browser. Until then the row leaves it blank.
  const displayName = user?.name?.trim() || user?.email || (isPending ? "" : "Account")
  const email = user?.email ?? ""

  async function handleSignOut() {
    await signOut().catch(() => undefined)
    await navigate({ to: "/login" })
  }

  return (
    <div className="flex items-center gap-1.5 pt-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Account and projects menu"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-overlay data-[state=open]:bg-overlay"
          >
            <Avatar className="size-[30px] border border-border">
              {user?.image ? <AvatarImage src={user.image} alt="" /> : null}
              <AvatarFallback className="bg-secondary font-mono text-[10.5px] font-medium uppercase">
                {displayName ? getInitials(displayName) : null}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] text-foreground">{email || displayName}</span>
              {email && displayName !== email ? (
                <span className="block truncate text-[11.5px] text-muted-foreground">{displayName}</span>
              ) : null}
            </span>
            <ChevronsUpDown aria-hidden="true" className="size-3.5 shrink-0 text-faint" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-64">
          <ProjectMenuItems projectId={projectId} />
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link to="/dashboard/settings">
              <UserRound />
              Account settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/dashboard/teams">
              <Users />
              Teams
            </Link>
          </DropdownMenuItem>
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

/**
 * The projects, grouped by team when any team project exists, then "New
 * project". The list scrolls when it is long.
 */
function ProjectMenuItems({ projectId }: { projectId: string | null }) {
  const { projects } = useProjectsSummary()
  const grouped = hasTeamProjects(projects)

  return (
    <>
      <div className="scrollbar-subtle max-h-72 overflow-y-auto">
        {groupProjectsByTeam(projects).map((group) => (
          <DropdownMenuGroup key={group.team?.id ?? "personal"}>
            <DropdownMenuLabel className="px-2 pt-2 pb-1">
              <MenuSectionLabel>{grouped ? (group.team?.name ?? "Personal") : "Projects"}</MenuSectionLabel>
            </DropdownMenuLabel>
            {group.projects.map((project) => (
              <DropdownMenuItem key={project.id} asChild>
                <Link to="/dashboard/projects/$projectId" params={{ projectId: project.id }}>
                  <ProjectMonogram project={project} className="size-5 rounded-sm text-[10.5px]" />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {project.id === projectId ? (
                    <Check aria-label="Current project" className="ml-auto text-primary-text" />
                  ) : null}
                </Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </div>
      <DropdownMenuItem asChild>
        <Link to="/dashboard/projects/new" className="text-muted-foreground">
          <span className="grid size-5 place-items-center rounded-sm border border-dashed border-border">
            <Plus aria-hidden="true" className="size-3" />
          </span>
          New project
        </Link>
      </DropdownMenuItem>
    </>
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

function getInitials(name: string): string {
  const parts = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase()
}
