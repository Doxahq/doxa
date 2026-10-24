import { createFileRoute } from "@tanstack/react-router"

import { ProjectGenerationsPage } from "~/components/dashboard/project-generations-page"
import { dashboardPendingView } from "~/components/dashboard/pending-view"
import { projectPagePending } from "~/components/dashboard/route-pending"
import { startProjectPrefetch } from "~/lib/dashboard/project-route-prefetch"

export const Route = createFileRoute("/dashboard/projects/$projectId/generations/")({
  ...projectPagePending,
  // Starts the page's requests while its code loads, then waits for the code only.
  // A hover preload runs it each time: TanStack Query decides what is fresh.
  preloadStaleTime: 0,
  loader: (ctx) => {
    startProjectPrefetch(ctx.context.queryClient, "generations", ctx.params)
    return projectPagePending.loader(ctx)
  },
  pendingComponent: dashboardPendingView("generations"),
  component: ProjectGenerationsRoute,
})

function ProjectGenerationsRoute() {
  const { projectId } = Route.useParams()
  return <ProjectGenerationsPage projectId={projectId} />
}
