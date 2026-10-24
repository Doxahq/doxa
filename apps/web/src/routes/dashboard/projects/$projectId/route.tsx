import { createFileRoute } from "@tanstack/react-router"

import { ProjectWorkspaceLayout } from "~/components/dashboard/project-workspace-layout"
import { startProjectPrefetch } from "~/lib/dashboard/project-route-prefetch"

export const Route = createFileRoute("/dashboard/projects/$projectId")({
  // Starts the shell's requests (project, branches). It returns at once, so
  // no page waits on it. A hover preload runs it each time: TanStack Query
  // decides what is fresh.
  preloadStaleTime: 0,
  loader: ({ context, params }) => startProjectPrefetch(context.queryClient, "workspace", params),
  component: ProjectWorkspaceRoute,
})

function ProjectWorkspaceRoute() {
  const { projectId } = Route.useParams()
  return <ProjectWorkspaceLayout projectId={projectId} />
}
