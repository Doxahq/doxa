import type { ComponentType, SVGProps } from "react"
import { useNavigate, useRouter } from "@tanstack/react-router"
import {
  Activity,
  BookText,
  Bot,
  FolderGit2,
  Github,
  Globe,
  Info,
  LogOut,
  Maximize2,
  PanelLeft,
  PenLine,
  Plus,
  Settings,
  UserRound,
  Users,
} from "lucide-react"

import { DoxabotIcon } from "~/components/dashboard/doxabot/doxabot-icon"
import { useSidebar } from "~/components/ui/sidebar"
import { useDashboardAuth } from "~/lib/auth/dashboard-auth-context"
import { DOXA_DOCS_URL, DOXA_GITHUB_URL } from "~/lib/dashboard/external-links"
import type { KeySequence } from "~/lib/dashboard/key-sequence"
import { useShell } from "~/lib/dashboard/shell-context"

/** The command groups, in the order the menu shows them. Projects show between "project" and "actions". */
export type CommandGroupId = "project" | "actions" | "account" | "help"

export interface DashboardCommand {
  id: string
  group: CommandGroupId
  label: string
  icon: CommandIcon
  /** More words that find the command in the search. */
  keywords?: readonly string[]
  /** A G-then-key shortcut. The menu registers it on the whole window. */
  sequence?: KeySequence
  /** A modifier shortcut that another part of the dashboard handles. The menu only shows it. */
  hint?: readonly string[]
  run: () => void
  /** Loads the page's code and starts its requests, as a hovered link does. The menu calls it when the row is highlighted. */
  preload?: () => void
}

/** A lucide icon, or a Doxa icon drawn the same way. */
type CommandIcon = ComponentType<SVGProps<SVGSVGElement>>

type ProjectPage =
  | "/dashboard/projects/$projectId/project"
  | "/dashboard/projects/$projectId/content"
  | "/dashboard/projects/$projectId/generations"
  | "/dashboard/projects/$projectId/doxabot"
  | "/dashboard/projects/$projectId/requests"
  | "/dashboard/projects/$projectId/settings"

/** Every command of the dashboard menu. The pages of the current project show only when one is open. */
export function useDashboardCommands(projectId: string | null): DashboardCommand[] {
  const navigate = useNavigate()
  const router = useRouter()
  const { openSiteSettings, toggleFocusMode, view } = useShell()
  const { toggleSidebar } = useSidebar()
  const { signOut } = useDashboardAuth()

  const openProjectPage = (id: string, to: ProjectPage) => void navigate({ to, params: { projectId: id } })
  const preloadProjectPage = (id: string, to: ProjectPage) =>
    void router.preloadRoute({ to, params: { projectId: id } }).catch(() => undefined)
  const openExternal = (url: string) => void window.open(url, "_blank", "noopener,noreferrer")

  /** Opens a page of the project, and preloads it when its row is highlighted. */
  const pageActions = (id: string, to: ProjectPage) =>
    [() => openProjectPage(id, to), () => preloadProjectPage(id, to)] as const

  const projectCommands: DashboardCommand[] = projectId
    ? [
        projectPage("overview", "Overview", Info, "o", ...pageActions(projectId, "/dashboard/projects/$projectId/project")),
        projectPage("content", "Content", PenLine, "c", ...pageActions(projectId, "/dashboard/projects/$projectId/content"), ["pages", "editor", "write"]),
        projectPage("generations", "Generations", Activity, "g", ...pageActions(projectId, "/dashboard/projects/$projectId/generations"), ["runs", "generate"]),
        projectPage("doxabot", "Doxabot", DoxabotIcon, "d", ...pageActions(projectId, "/dashboard/projects/$projectId/doxabot"), ["bot", "instructions", "pull requests", "cache"]),
        projectPage("requests", "Requests", Bot, "r", ...pageActions(projectId, "/dashboard/projects/$projectId/requests"), ["approvals", "agents"]),
        projectPage("settings", "Project settings", Settings, "s", ...pageActions(projectId, "/dashboard/projects/$projectId/settings")),
        projectPage("site-settings", "Site settings", Globe, "w", () => openSiteSettings(projectId), undefined, ["theme", "navigation", "domain"]),
      ]
    : []

  return [
    ...projectCommands,
    {
      id: "new-project",
      group: "actions",
      label: "New project",
      icon: Plus,
      keywords: ["create", "repository"],
      sequence: ["c", "p"],
      run: () => void navigate({ to: "/dashboard/projects/new" }),
    },
    {
      id: "all-projects",
      group: "actions",
      label: "All projects",
      icon: FolderGit2,
      sequence: ["g", "p"],
      run: () => void navigate({ to: "/dashboard/projects" }),
    },
    {
      id: "toggle-sidebar",
      group: "actions",
      label: "Toggle sidebar",
      icon: PanelLeft,
      keywords: ["hide", "show"],
      hint: ["⌘", "\\"],
      run: toggleSidebar,
    },
    ...(view === "content"
      ? [
          {
            id: "focus-mode",
            group: "actions",
            label: "Toggle focus mode",
            icon: Maximize2,
            keywords: ["zen", "distraction"],
            hint: ["⌘", "."],
            run: toggleFocusMode,
          } satisfies DashboardCommand,
        ]
      : []),
    {
      id: "account-settings",
      group: "account",
      label: "Account settings",
      icon: UserRound,
      keywords: ["profile", "approvals"],
      sequence: ["g", "a"],
      run: () => void navigate({ to: "/dashboard/settings" }),
    },
    {
      id: "teams",
      group: "account",
      label: "Teams",
      icon: Users,
      keywords: ["members", "invite"],
      sequence: ["g", "t"],
      run: () => void navigate({ to: "/dashboard/teams" }),
    },
    {
      id: "sign-out",
      group: "account",
      label: "Sign out",
      icon: LogOut,
      keywords: ["log out"],
      run: () =>
        void signOut()
          .catch(() => undefined)
          .then(() => navigate({ to: "/login" })),
    },
    {
      id: "docs",
      group: "help",
      label: "Doxa documentation",
      icon: BookText,
      keywords: ["help", "guide"],
      run: () => openExternal(DOXA_DOCS_URL),
    },
    {
      id: "github",
      group: "help",
      label: "Doxa on GitHub",
      icon: Github,
      keywords: ["source", "issues"],
      run: () => openExternal(DOXA_GITHUB_URL),
    },
  ]
}

/** A page of the current project, reached with G and one more key. */
function projectPage(
  id: string,
  label: string,
  icon: CommandIcon,
  key: string,
  run: () => void,
  preload?: () => void,
  keywords?: readonly string[],
): DashboardCommand {
  return { id, group: "project", label, icon, keywords, sequence: ["g", key], run, preload }
}

/** The cmdk value of a command row. The highlighted row is found by it. */
export function commandValue(command: Pick<DashboardCommand, "id" | "label">): string {
  return `${command.label} ${command.id}`
}
