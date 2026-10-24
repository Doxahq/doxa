import { createFileRoute } from "@tanstack/react-router"

import { ProjectRequestsPage } from "~/components/dashboard/requests/project-requests-page"
import { dashboardPendingView } from "~/components/dashboard/pending-view"
import { projectPagePending } from "~/components/dashboard/route-pending"
import { startProjectPrefetch } from "~/lib/dashboard/project-route-prefetch"

export const Route = createFileRoute("/dashboard/projects/$projectId/requests/")({
  ...projectPagePending,
  // Starts the page's requests while its code loads, then waits for the code only.
  // A hover preload runs it each time: TanStack Query decides what is fresh.
  preloadStaleTime: 0,
  loader: (ctx) => {
    startProjectPrefetch(ctx.context.queryClient, "requests", ctx.params)
    return projectPagePending.loader(ctx)
  },
  pendingComponent: dashboardPendingView("projectRequests"),
  component: ProjectRequestsRoute,
})

function ProjectRequestsRoute() {
  const { projectId } = Route.useParams()
  return <ProjectRequestsPage projectId={projectId} />
}
