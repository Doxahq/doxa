import { useEffect } from "react"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import { AlertCircle } from "lucide-react"

import { DashboardHeader, PageBody } from "~/components/dashboard/dashboard-header"
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Skeleton } from "~/components/ui/skeleton"
import { readLastProjectId, resolveLandingProjectId } from "~/lib/dashboard/last-project"
import { readPendingRepositoryConnect } from "~/lib/dashboard/pending-repository-connect"
import { useProjectsSummary } from "~/lib/dashboard/use-projects-summary"

/**
 * `/dashboard` has no page of its own. It opens the last project the user
 * opened, else the first project, else the new project flow.
 *
 * A user with no project lands on the new project page, which is the
 * onboarding screen. A returning user keeps landing in a project.
 *
 * GitHub sends the user back to `/dashboard?github=connected` after the app
 * install, which starts from the "Generate from a repository" dialog, so that
 * case reopens it. When the install started from a project without a
 * repository, it returns to that project instead, where the overview finishes
 * the connection.
 */
export function DashboardLanding() {
  const navigate = useNavigate()
  const search = useRouterState({ select: (state) => state.location.search })
  const { projects, isPending, error } = useProjectsSummary()
  const githubConnected = (search as Record<string, unknown>).github === "connected"

  useEffect(() => {
    if (isPending || error) return
    const projectId = githubConnected
      ? resolvePendingConnectProjectId(projects)
      : resolveLandingProjectId(projects, readLastProjectId())
    if (projectId) {
      void navigate({ to: "/dashboard/projects/$projectId/project", params: { projectId }, replace: true })
    } else {
      void navigate({
        to: "/dashboard/projects/new",
        search: githubConnected ? { start: "repository" } : {},
        replace: true,
      })
    }
  }, [error, githubConnected, isPending, navigate, projects])

  return (
    <>
      <DashboardHeader title="Dashboard" />
      <PageBody>
        {error ? (
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>Could not load your projects</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : (
          <Skeleton className="h-40 w-full" />
        )}
      </PageBody>
    </>
  )
}

function resolvePendingConnectProjectId(projects: readonly { id: string }[]): string | null {
  const pendingProjectId = readPendingRepositoryConnect()
  return pendingProjectId && projects.some(({ id }) => id === pendingProjectId) ? pendingProjectId : null
}
