import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate, useRouter } from "@tanstack/react-router"

import { readLastProjectId } from "~/lib/dashboard/last-project"
import { sidebarViewForPath } from "~/lib/dashboard/shell-context"
import { usePageSettled } from "~/lib/dashboard/use-page-settled"
import { useRenderedPathname } from "~/lib/dashboard/use-rendered-pathname"
import { buildWorkspaces, findWorkspace, type Workspace, type WorkspaceId } from "~/lib/dashboard/workspace-model"
import {
  isWorkspacePage,
  resolveCurrentWorkspaceId,
  switchDestination,
  workspacePageScope,
  type SwitchDestination,
} from "~/lib/dashboard/workspace-routing"
import {
  readLastProjectIdIn,
  readStoredWorkspaceId,
  subscribeWorkspaceStorage,
  writeLastProjectIdIn,
  writeStoredWorkspaceId,
} from "~/lib/dashboard/workspace-storage"
import { billingAccountsQueryOptions } from "~/lib/queries/billing"
import { projectsListQueryOptions } from "~/lib/queries/dashboard"
import { teamsQueryOptions } from "~/lib/queries/teams"

export interface WorkspaceContextValue {
  /** The workspace on screen. Null until it is known: pages then keep their loading state. */
  readonly current: Workspace | null
  /** Personal first, then the teams by name. */
  readonly workspaces: readonly Workspace[]
  /** True while the teams list loads. Team roles and member counts are unknown until then. */
  readonly isTeamsPending: boolean
  /**
   * The first breadcrumb of a page of one workspace ("Coder One / Overview"),
   * so the person always sees where they are. Null for a person with only
   * the personal workspace, and on pages of no workspace.
   */
  readonly crumb: string | null
  /** The workspace menu under the logo. Other controls ("Change workspace") open it too. */
  readonly isMenuOpen: boolean
  readonly setMenuOpen: (open: boolean) => void
  readonly switchTo: (workspaceId: WorkspaceId) => void
  /** Loads the page that a switch to the workspace opens, so the switch shows it at once. */
  readonly preloadSwitch: (workspaceId: WorkspaceId) => void
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

/** The stored choice; undefined in the server render and during hydration, so both stay identical. */
function useStoredWorkspaceId(): WorkspaceId | null | undefined {
  return useSyncExternalStore(subscribeWorkspaceStorage, readStoredWorkspaceId, () => undefined)
}

/**
 * The current workspace (Personal or a team) and the switch. The page
 * decides it where it belongs to one workspace (a project, a billing
 * account); elsewhere it is the person's choice, which the browser keeps.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const router = useRouter()
  const pathname = useRenderedPathname()
  const scope = useMemo(() => workspacePageScope(pathname), [pathname])
  const storedId = useStoredWorkspaceId()
  const [isMenuOpen, setMenuOpen] = useState(false)
  const isSettled = usePageSettled()

  const projectsQuery = useQuery(projectsListQueryOptions())
  const teamsQuery = useQuery(teamsQueryOptions())
  // The plans label the menu and lead to billing, so the read waits until the
  // page settles, unless the menu or an account page (billing) needs it now.
  const accountsQuery = useQuery({
    ...billingAccountsQueryOptions(),
    enabled: isSettled || isMenuOpen || sidebarViewForPath(pathname) === "account",
  })

  const projects = projectsQuery.data
  const teamsKnown = teamsQuery.data !== undefined || teamsQuery.isError
  const billingAccounts = accountsQuery.data?.accounts
  const workspaces = useMemo(
    () => buildWorkspaces({ projects: projects ?? [], teams: teamsQuery.data, billingAccounts }),
    [projects, teamsQuery.data, billingAccounts],
  )
  const currentId = resolveCurrentWorkspaceId({
    scope,
    workspaces,
    projects,
    billingAccounts,
    storedId,
    lastProjectId: storedId === undefined ? null : readLastProjectId(),
    teamsKnown,
  })
  const current = findWorkspace(workspaces, currentId)

  // A page of one workspace makes it the chosen one, and records its project
  // as the one to land on when the person comes back to that workspace.
  const pageWorkspaceId = scope.kind === "chosen" ? null : currentId
  const pageProjectId = scope.kind === "project" ? scope.projectId : null
  useEffect(() => {
    if (pageWorkspaceId === null) return
    writeStoredWorkspaceId(pageWorkspaceId)
    if (pageProjectId) writeLastProjectIdIn(pageWorkspaceId, pageProjectId)
  }, [pageWorkspaceId, pageProjectId])

  const destinationOf = useCallback(
    (workspaceId: WorkspaceId): { target: Workspace; destination: SwitchDestination } | null => {
      const target = findWorkspace(workspaces, workspaceId)
      if (!target) return null
      const destination = switchDestination({
        pathname,
        target,
        projects: projects ?? [],
        lastProjectIdInTarget: readLastProjectIdIn(target.id),
      })
      return { target, destination }
    },
    [pathname, projects, workspaces],
  )

  const switchTo = useCallback(
    (workspaceId: WorkspaceId) => {
      setMenuOpen(false)
      const next = destinationOf(workspaceId)
      if (!next || next.target.id === currentId) return
      // On a project or billing page the page decides the workspace, so the
      // new choice shows with the new page, never on top of the old one.
      writeStoredWorkspaceId(next.target.id)
      if (next.destination) void navigate(next.destination)
    },
    [currentId, destinationOf, navigate],
  )

  const preloadSwitch = useCallback(
    (workspaceId: WorkspaceId) => {
      const destination = destinationOf(workspaceId)?.destination
      if (destination) void router.preloadRoute(destination).catch(() => undefined)
    },
    [destinationOf, router],
  )

  const crumb = current && workspaces.length > 1 && isWorkspacePage(pathname) ? current.name : null
  const value = useMemo<WorkspaceContextValue>(
    () => ({
      current,
      workspaces,
      isTeamsPending: !teamsKnown,
      crumb,
      isMenuOpen,
      setMenuOpen,
      switchTo,
      preloadSwitch,
    }),
    [current, workspaces, teamsKnown, crumb, isMenuOpen, switchTo, preloadSwitch],
  )

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error("useWorkspace must be used inside WorkspaceProvider.")
  return value
}

/** `crumb` of the current workspace; null outside the dashboard shell. */
export function useWorkspaceCrumb(): string | null {
  return useContext(WorkspaceContext)?.crumb ?? null
}
