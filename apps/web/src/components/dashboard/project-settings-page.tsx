import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ChevronRight, ShieldCheck } from "lucide-react"

import { PageBody, PageHeading } from "~/components/dashboard/dashboard-header"
import { ProjectDeleteCard } from "~/components/dashboard/project-delete-card"
import { ProjectExportCard } from "~/components/dashboard/project-export-card"
import { ProjectTeamCard } from "~/components/dashboard/project-team-card"
import { Button } from "~/components/ui/button"
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card"
import { canMoveProjectToTeam } from "~/lib/dashboard/teams-model"
import { useProjectCapabilities } from "~/lib/dashboard/use-project-capabilities"
import { projectDetailQueryOptions } from "~/lib/queries/dashboard"
import { teamsQueryOptions } from "~/lib/queries/teams"
import { docsExportStatusQueryOptions } from "~/lib/queries/docs-export"
import { ProjectSettingsSkeleton } from "~/components/dashboard/skeletons/settings-skeletons"
import { useIsFirstLoad } from "~/lib/dashboard/use-first-load"

/**
 * Project settings: the team and agent approvals. Doxabot, its instructions
 * and the generation cache live on the Doxabot page.
 */
export function ProjectSettingsPage({ projectId }: { projectId: string }) {
  const projectQuery = useQuery(projectDetailQueryOptions(projectId))
  const project = projectQuery.data?.project ?? null
  // The Team card lists the teams that can take the project. Only an owner of
  // a personal project sees that list, so only then does the page load it.
  const canMoveToTeam = projectQuery.data
    ? canMoveProjectToTeam(projectQuery.data.project, projectQuery.data.role)
    : false
  const teamsQuery = useQuery({ ...teamsQueryOptions(), enabled: canMoveToTeam })
  const { can } = useProjectCapabilities(projectId)
  // An export spends the quota of the project's account: editors and up.
  const canExport = can("docs.write")
  const exportQuery = useQuery({ ...docsExportStatusQueryOptions(projectId), enabled: canExport })

  // The page waits for every card's data, so it shows one skeleton and then
  // every card at once, not cards popping in one by one.
  const isFirstLoad = useIsFirstLoad([
    projectQuery,
    { isPending: canMoveToTeam && teamsQuery.isPending },
    { isPending: canExport && exportQuery.isPending },
  ])

  if (isFirstLoad) return <ProjectSettingsSkeleton />

  return (
    <PageBody className="max-w-4xl">
      <PageHeading
        label="Project"
        title="Settings"
        description="Who works on this project, what agents can do in it, and how to export it."
      />

      <section className="flex flex-col gap-4">
        <AgentApprovalsCard projectId={projectId} />

        <ProjectTeamCard projectId={projectId} />

        {canExport ? <ProjectExportCard projectId={projectId} status={exportQuery} /> : null}

        {can("project.delete") ? (
          <ProjectDeleteCard
            projectId={projectId}
            projectName={project?.name ?? null}
            projectSlug={project?.slug ?? null}
          />
        ) : null}
      </section>
    </PageBody>
  )
}

/** Links to Project settings → Agent approvals. */
function AgentApprovalsCard({ projectId }: { projectId: string }) {
  return (
    <Card>
      <CardHeader className="gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-col gap-1.5">
            <CardTitle>
              <h3>Agent approvals</h3>
            </CardTitle>
            <CardDescription>
              Choose which agent actions run at once, which wait for you, and which never run.
            </CardDescription>
          </div>
        </div>
        <Button variant="outline" className="w-fit shrink-0" asChild>
          <Link to="/dashboard/projects/$projectId/settings/approvals" params={{ projectId }}>
            Manage
            <ChevronRight aria-hidden="true" />
          </Link>
        </Button>
      </CardHeader>
    </Card>
  )
}
