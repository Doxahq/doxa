import { Link, useNavigate } from "@tanstack/react-router"
import { Plus } from "lucide-react"

import { ContentSidebarSkeleton } from "~/components/dashboard/content/content-sidebar-skeleton"
import { AccountSidebarView } from "~/components/dashboard/shell/account-sidebar-view"
import { ProjectSidebarView } from "~/components/dashboard/shell/project-sidebar-view"
import { SiteSettingsButton, UserRow } from "~/components/dashboard/shell/sidebar-footer"
import { SidebarSearchButton } from "~/components/dashboard/shell/sidebar-search-button"
import { SidebarResizeHandle } from "~/components/dashboard/shell/sidebar-resize-handle"
import { SidebarViewFooter, SidebarViewHeader, SidebarViewStack } from "~/components/dashboard/shell/sidebar-view-stack"
import { SiteSettingsSidebarView } from "~/components/dashboard/shell/site-settings-sidebar-view"
import { WorkspaceMenu } from "~/components/dashboard/shell/workspace-menu"
import { Sidebar, SidebarHeader } from "~/components/ui/sidebar"
import { useSidebarPanelSlot } from "~/lib/dashboard/sidebar-panel-context"
import type { useSidebarWidth } from "~/lib/dashboard/sidebar-width"
import { useContentOverviewFailed } from "~/lib/dashboard/use-content-overview-failed"
import { useWorkspace } from "~/lib/dashboard/workspace-context"
import { canCreateProjectIn, isPersonalWorkspace } from "~/lib/dashboard/workspace-model"

/**
 * The dashboard sidebar: a fixed header (the logo, which opens the workspace
 * menu, over the search button) over four sliding views (Project, Content,
 * Site settings, Account). The project title switches projects of the
 * current workspace.
 *
 * The Content view body comes from the content route, which owns the editor
 * state, through the sidebar panel slot.
 */
export function AppSidebar({
  projectId,
  sidebarWidth,
}: {
  projectId: string | null
  sidebarWidth: ReturnType<typeof useSidebarWidth>
}) {
  const contentPanel = useSidebarPanelSlot()

  return (
    <Sidebar>
      <SidebarResizeHandle
        width={sidebarWidth.width}
        onWidthChange={sidebarWidth.setWidth}
        onReset={sidebarWidth.resetWidth}
      />
      <SidebarHeader className="gap-3.5 border-b border-divider px-3 pt-4 pb-3">
        <WorkspaceMenu />
        <SidebarSearchButton />
      </SidebarHeader>

      <SidebarViewStack
        views={{
          project: projectId ? (
            <>
              <ProjectSidebarView projectId={projectId} />
              <SidebarViewFooter>
                <SiteSettingsButton projectId={projectId} />
                <UserRow />
              </SidebarViewFooter>
            </>
          ) : (
            <NoProjectView />
          ),
          content:
            projectId ? (
              <>
                {contentPanel ?? <ContentViewPlaceholder projectId={projectId} />}
                <SidebarViewFooter>
                  <SiteSettingsButton projectId={projectId} />
                  <UserRow showLinks={false} />
                </SidebarViewFooter>
              </>
            ) : null,
          site: projectId ? <SiteSettingsSidebarView projectId={projectId} /> : null,
          account: <AccountSidebarView projectId={projectId} />,
        }}
      />
    </Sidebar>
  )
}

/**
 * The Content view before the editor fills it. It shows the skeleton of the
 * page list from the server render until the editor publishes the real list,
 * which it does in the same frame as the page body. A project without docs
 * keeps an empty view. Both keep the way back to the project overview.
 */
function ContentViewPlaceholder({ projectId }: { projectId: string }) {
  const navigate = useNavigate()
  const hasNoList = useContentOverviewFailed(projectId)
  const back = () => void navigate({ to: "/dashboard/projects/$projectId/project", params: { projectId } })
  if (!hasNoList) return <ContentSidebarSkeleton onBack={back} />
  return (
    <>
      <SidebarViewHeader label="Content" backLabel="Back to overview" onBack={back} />
      <div className="flex-1" />
    </>
  )
}

/**
 * Shown when the current workspace has no project yet. Until the workspace
 * is known it stays empty, so the message never shows before a project does.
 */
function NoProjectView() {
  const { current } = useWorkspace()

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col items-start gap-3 px-4 py-6">
        {current ? (
          <>
            <p className="text-[13px] leading-6 text-muted-foreground">
              {isPersonalWorkspace(current) ? "" : `${current.name} has no projects yet. `}
              {canCreateProjectIn(current)
                ? "Generate docs from a GitHub repository, or start from the starter docs or an empty site."
                : "An owner or admin of the team can create the first one."}
            </p>
            {canCreateProjectIn(current) ? (
              <Link
                to="/dashboard/projects/new"
                className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-[13px] text-foreground transition-colors hover:border-border-strong hover:bg-surface-hover"
              >
                <Plus aria-hidden="true" className="size-4" />
                New project
              </Link>
            ) : null}
          </>
        ) : null}
      </div>
      <SidebarViewFooter>
        <UserRow />
      </SidebarViewFooter>
    </>
  )
}
