import { createFileRoute } from "@tanstack/react-router"

import { ProjectDoxabotPage } from "~/components/dashboard/doxabot/doxabot-page"
import { dashboardPendingView } from "~/components/dashboard/pending-view"
import { projectPagePending } from "~/components/dashboard/route-pending"
import { startProjectPrefetch } from "~/lib/dashboard/project-route-prefetch"

export const Route = createFileRoute("/dashboard/projects/$projectId/doxabot/")({
  ...projectPagePending,
  // Starts the page's requests while its code loads, then waits for the code only.
  // A hover preload runs it each time: TanStack Query decides what is fresh.
  preloadStaleTime: 0,
  loader: (ctx) => {
    startProjectPrefetch(ctx.context.queryClient, "doxabot", ctx.params)
    return projectPagePending.loader(ctx)
  },
  pendingComponent: dashboardPendingView("projectDoxabot"),
  component: ProjectDoxabotRoute,
})

function ProjectDoxabotRoute() {
  const { projectId } = Route.useParams()
  return <ProjectDoxabotPage projectId={projectId} />
}
