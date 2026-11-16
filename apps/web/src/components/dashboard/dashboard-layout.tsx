import { useEffect, useState, type CSSProperties, type ReactNode } from "react"
import { Outlet, useParams } from "@tanstack/react-router"

import { AppSidebar } from "~/components/dashboard/app-sidebar"
import { BillingDenialDialogHost } from "~/components/dashboard/billing/billing-denial-dialog"
import { ProTrialDialogProvider } from "~/components/dashboard/billing/pro-trial-dialog"
import { ProjectBillingBanner } from "~/components/dashboard/billing/project-billing-banner"
import { CommandMenuProvider } from "~/components/dashboard/command-menu/command-menu"
import { registerDashboardPendingViews } from "~/components/dashboard/pending-view"
import { DASHBOARD_PENDING_VIEWS } from "~/components/dashboard/skeletons/pending-views"
import { StatusBar } from "~/components/dashboard/status-bar"
import { SidebarInset, SidebarProvider } from "~/components/ui/sidebar"
import { Toaster } from "~/components/ui/sonner"
import { DashboardAuthProvider } from "~/lib/auth/dashboard-auth-context"
import { readLastProjectId, resolveLandingProjectId } from "~/lib/dashboard/last-project"
import { ProjectBranchProvider } from "~/lib/dashboard/project-branch-context"
import { ShellProvider } from "~/lib/dashboard/shell-context"
import { useSidebarWidth } from "~/lib/dashboard/sidebar-width"
import { SidebarPanelProvider } from "~/lib/dashboard/sidebar-panel-context"
import { useProjectsSummary } from "~/lib/dashboard/use-projects-summary"
import { Route as DashboardRoute } from "~/routes/dashboard/route"

interface ShellStyle extends CSSProperties {
  "--status-bar-height": string
}

const SHELL_STYLE: ShellStyle = { "--status-bar-height": "2rem" }

// The skeletons that dashboard routes show while a page loads. Every
// dashboard route renders inside this layout, so they are ready before any
// of them shows, and they stay out of the main bundle.
registerDashboardPendingViews(DASHBOARD_PENDING_VIEWS)

export function DashboardLayout() {
  const { dashboardEntry } = DashboardRoute.useLoaderData()

  return (
    <DashboardAuthProvider devSession={dashboardEntry.devSession} identityHint={dashboardEntry.identityHint}>
      <ProTrialDialogProvider>
        <SidebarPanelProvider>
          <DashboardShell />
        </SidebarPanelProvider>
        <Toaster />
        <BillingDenialDialogHost />
      </ProTrialDialogProvider>
    </DashboardAuthProvider>
  )
}

/**
 * The dashboard frame: a full-height sidebar, and the main area with the
 * status bar under it. The status bar starts where the sidebar ends, so the
 * sidebar keeps its full height.
 *
 * The shell always shows one project. On a project route it is that project.
 * Elsewhere (account settings, new project) it is the last opened project, so
 * the sidebar keeps its navigation.
 */
function DashboardShell() {
  const projectId = useShellProjectId()
  const sidebarWidth = useSidebarWidth()

  return (
    <SidebarProvider
      data-dashboard-shell=""
      className="font-sans text-body"
      style={{ ...SHELL_STYLE, ...sidebarWidth.style }}
    >
      <ShellProvider>
        <CommandMenuProvider projectId={projectId}>
          <ProjectScope projectId={projectId}>
            <AppSidebar projectId={projectId} sidebarWidth={sidebarWidth} />
            <SidebarInset className="h-svh min-h-0 min-w-0 overflow-hidden">
              <main className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-subtle">
                <ProjectBillingBanner projectId={projectId} />
                <Outlet />
              </main>
              <StatusBar />
            </SidebarInset>
          </ProjectScope>
        </CommandMenuProvider>
      </ShellProvider>
    </SidebarProvider>
  )
}

function ProjectScope({ projectId, children }: { projectId: string | null; children: ReactNode }) {
  if (!projectId) return children
  // A new key per project resets the branch selection to that project's own.
  return (
    <ProjectBranchProvider key={projectId} projectId={projectId}>
      {children}
    </ProjectBranchProvider>
  )
}

function useShellProjectId(): string | null {
  const params = useParams({ strict: false })
  const routeProjectId = typeof params.projectId === "string" ? params.projectId : null
  const { projects } = useProjectsSummary()
  // Storage is read after mount, so the server render and the first client
  // render stay identical.
  const [lastProjectId, setLastProjectId] = useState<string | null>(null)
  useEffect(() => setLastProjectId(readLastProjectId()), [routeProjectId])

  return routeProjectId ?? resolveLandingProjectId(projects, lastProjectId)
}
