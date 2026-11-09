import { Link, useNavigate } from "@tanstack/react-router"
import { Plus } from "lucide-react"

import { LogoWordmark } from "~/components/navigation/logo"
import { ContentSidebarSkeleton } from "~/components/dashboard/content/content-sidebar-skeleton"
import { ProjectSidebarView } from "~/components/dashboard/shell/project-sidebar-view"
import { SiteSettingsButton, UserRow } from "~/components/dashboard/shell/sidebar-footer"
import { SidebarSearchButton } from "~/components/dashboard/shell/sidebar-search-button"
import { SidebarResizeHandle } from "~/components/dashboard/shell/sidebar-resize-handle"
import { SidebarViewFooter, SidebarViewHeader, SidebarViewStack } from "~/components/dashboard/shell/sidebar-view-stack"
import { SiteSettingsSidebarView } from "~/components/dashboard/shell/site-settings-sidebar-view"
import { Sidebar, SidebarHeader } from "~/components/ui/sidebar"
import { useSidebarPanelSlot } from "~/lib/dashboard/sidebar-panel-context"
import type { useSidebarWidth } from "~/lib/dashboard/sidebar-width"
import { useContentOverviewFailed } from "~/lib/dashboard/use-content-overview-failed"

/**
 * The dashboard sidebar: a fixed header (logo over the search button) over
 * three sliding views (Project, Content, Site settings). The project title
 * and the account menu in the footer switch projects.
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
        <Link to="/dashboard" aria-label="Doxa dashboard" className="w-fit px-1">
          <LogoWordmark size={14} />
        </Link>
        <SidebarSearchButton />
      </SidebarHeader>

      <SidebarViewStack
        views={{
          project: projectId ? (
            <>
              <ProjectSidebarView projectId={projectId} />
              <SidebarViewFooter>
                <SiteSettingsButton projectId={projectId} />
                <UserRow projectId={projectId} />
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
                  <UserRow projectId={projectId} showLinks={false} />
                </SidebarViewFooter>
              </>
            ) : null,
          site: projectId ? <SiteSettingsSidebarView projectId={projectId} /> : null,
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

/** Shown when the account has no project yet. */
function NoProjectView() {
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col items-start gap-3 px-4 py-6">
        <p className="text-[13px] leading-6 text-muted-foreground">
          Generate docs from a GitHub repository, or start from the starter docs or an empty site.
        </p>
        <Link
          to="/dashboard/projects/new"
          className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-[13px] text-foreground transition-colors hover:border-border-strong hover:bg-surface-hover"
        >
          <Plus aria-hidden="true" className="size-4" />
          New project
        </Link>
      </div>
      <SidebarViewFooter>
        <UserRow projectId={null} />
      </SidebarViewFooter>
    </>
  )
}
