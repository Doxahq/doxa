import { useEffect } from "react"
import { Outlet } from "@tanstack/react-router"

import {
  SITE_SETTINGS_SECTIONS,
  siteSettingsSectionLabel,
} from "~/components/dashboard/shell/site-settings-sidebar-view"
import { MoreMenu, SiteMenuItems, TopBar } from "~/components/dashboard/shell/top-bar"
import { shortenGenerationId } from "~/lib/dashboard/generation-model"
import { ProjectGenerationStreamProvider } from "~/lib/dashboard/generation-stream-context"
import { writeLastProjectId } from "~/lib/dashboard/last-project"
import { useLocationCheckoutReturn } from "~/lib/dashboard/use-checkout-return"
import { usePreloadProjectRoutes } from "~/lib/dashboard/use-preload-project-routes"
import { useIsProjectPagePending } from "~/lib/dashboard/use-project-page-pending"
import { useProjectWorkspace } from "~/lib/dashboard/use-project-workspace"
import { useRenderedPathname } from "~/lib/dashboard/use-rendered-pathname"

/**
 * Frame for every project route. Navigation lives in the sidebar. The content
 * editor and site settings render their own top bar, because their controls
 * depend on their own state. While one of them loads, this frame draws a
 * plain top bar in its place, so the loading view has the same frame as every
 * other page.
 */
export function ProjectWorkspaceLayout({ projectId }: { projectId: string }) {
  const workspace = useProjectWorkspace(projectId)
  const pathname = useRenderedPathname()
  const isPagePending = useIsProjectPagePending()
  const crumbs = projectCrumbs(pathname, projectId, isPagePending)

  useEffect(() => writeLastProjectId(projectId), [projectId])
  usePreloadProjectRoutes()
  // A Pro trial started on a project page returns to that page with `?checkout=<id>`.
  useLocationCheckoutReturn()

  return (
    <>
      {crumbs ? (
        <TopBar
          crumbs={crumbs}
          menu={
            <MoreMenu>
              <SiteMenuItems projectId={projectId} />
            </MoreMenu>
          }
        />
      ) : null}
      <ProjectGenerationStreamProvider projectId={projectId} generation={workspace.latestJob}>
        <Outlet />
      </ProjectGenerationStreamProvider>
    </>
  )
}

/**
 * Breadcrumb for the simple project pages. Null for pages with their own top
 * bar, unless the page is still loading.
 */
export function projectCrumbs(pathname: string, projectId: string, isPagePending: boolean): string[] | null {
  const rest = pathname.slice(`/dashboard/projects/${projectId}`.length).split("/").filter(Boolean)
  switch (rest[0]) {
    case "content":
      return isPagePending ? ["Content"] : null
    case "site": {
      if (!isPagePending) return null
      const section = SITE_SETTINGS_SECTIONS.find((item) => item === rest[1]) ?? "appearance"
      return ["Site settings", siteSettingsSectionLabel(section)]
    }
    case "generations":
      if (!rest[1]) return ["Generations"]
      return rest[2] === "changes"
        ? ["Generations", shortenGenerationId(rest[1]), "Changes"]
        : ["Generations", shortenGenerationId(rest[1])]
    case "doxabot":
      return rest[1] === "instructions" ? ["Doxabot", "Instructions"] : ["Doxabot"]
    case "requests":
      return ["Requests"]
    case "settings":
      return rest[1] === "approvals" ? ["Settings", "Agent approvals"] : ["Settings"]
    default:
      return ["Overview"]
  }
}
