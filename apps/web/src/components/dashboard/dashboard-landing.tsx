import { useEffect } from "react"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import { AlertCircle, RefreshCw } from "lucide-react"

import { DashboardHeader, PageBody } from "~/components/dashboard/dashboard-header"
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Skeleton } from "~/components/ui/skeleton"
import { readLastProjectId, resolveLandingProjectId } from "~/lib/dashboard/last-project"
import { readPendingRepositoryConnect } from "~/lib/dashboard/pending-repository-connect"
import { getApiUrl } from "~/lib/platform-api"
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
 *
 * `/dashboard?github=pending&installation_id=…` means GitHub had not yet told
 * Doxa who installed the app on an organization. The page stays and offers to
 * connect that installation again.
 */
export function DashboardLanding() {
  const navigate = useNavigate()
  const search = useRouterState({ select: (state) => state.location.search })
  const { projects, isPending, error } = useProjectsSummary()
  const githubConnected = (search as Record<string, unknown>).github === "connected"
  const pendingInstallationId = readPendingInstallationId(search)

  useEffect(() => {
    if (isPending || error || pendingInstallationId) return
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
  }, [error, githubConnected, isPending, navigate, pendingInstallationId, projects])

  if (pendingInstallationId) {
    return (
      <>
        <DashboardHeader title="Dashboard" />
        <PageBody>
          <Alert>
            <AlertCircle aria-hidden="true" />
            <AlertTitle>GitHub is still setting up the installation</AlertTitle>
            <AlertDescription>
              <p>GitHub has not told Doxa who installed the app yet. Wait a few seconds, then try again.</p>
              <Button variant="outline" size="sm" className="mt-3" asChild>
                <a href={getApiUrl(`/github/install/callback?installation_id=${encodeURIComponent(pendingInstallationId)}`)}>
                  <RefreshCw />
                  Try again
                </a>
              </Button>
            </AlertDescription>
          </Alert>
        </PageBody>
      </>
    )
  }

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

/** The installation of a `github=pending` return, only when it is a GitHub installation ID. */
function readPendingInstallationId(search: unknown): string | null {
  const params = search as Record<string, unknown>
  if (params.github !== "pending") return null
  const installationId = String(params.installation_id ?? "")
  return /^[1-9][0-9]{0,19}$/.test(installationId) ? installationId : null
}

function resolvePendingConnectProjectId(projects: readonly { id: string }[]): string | null {
  const pendingProjectId = readPendingRepositoryConnect()
  return pendingProjectId && projects.some(({ id }) => id === pendingProjectId) ? pendingProjectId : null
}
