import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { AlertCircle } from "lucide-react"

import { ConnectRepositoryDialog } from "~/components/dashboard/connect-repository-dialog"
import { PageBody, PageHeading } from "~/components/dashboard/dashboard-header"
import { GenerationStartDialogs } from "~/components/dashboard/generation-start-dialogs"
import { ActivityCard } from "~/components/dashboard/overview/activity-card"
import {
  AttentionAllClear,
  AttentionQueue,
  buildAttentionItems,
} from "~/components/dashboard/overview/attention-queue"
import { LiveSiteCard } from "~/components/dashboard/overview/live-site-card"
import { OpenPreviewsCard } from "~/components/dashboard/overview/open-previews-card"
import { SetupChecklist } from "~/components/dashboard/overview/setup-checklist"
import { ProjectOverviewSkeleton } from "~/components/dashboard/skeletons/project-skeletons"
import { useDashboardPageReady } from "~/lib/dashboard/dashboard-boot"
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import {
  clearPendingRepositoryConnect,
  readPendingRepositoryConnect,
} from "~/lib/dashboard/pending-repository-connect"
import { useGenerationStartFlow } from "~/lib/dashboard/use-generation-start-flow"
import { useIsFirstLoad } from "~/lib/dashboard/use-first-load"
import { useProjectCapabilities } from "~/lib/dashboard/use-project-capabilities"
import { useProjectGenerations } from "~/lib/dashboard/use-project-generations"
import { useProjectSetup } from "~/lib/dashboard/use-project-setup"
import { useProjectWorkspace } from "~/lib/dashboard/use-project-workspace"
import { approvalRequestListQueryOptions } from "~/lib/queries/approval-requests"
import {
  docsDomainsQueryOptions,
  pendingMergesQueryOptions,
  projectContentMdxReportQueryOptions,
  projectDoxabotQueryOptions,
  projectOverviewQueryOptions,
} from "~/lib/queries/dashboard"
import { generationReviewQueryOptions } from "~/lib/queries/generation-review"

export function ProjectOverviewPage({ projectId }: { projectId: string }) {
  const workspace = useProjectWorkspace(projectId)
  const generations = useProjectGenerations(projectId)
  const capabilities = useProjectCapabilities(projectId)
  // Connecting a repository and starting a generation both need `generation.run`.
  const canRun = capabilities.can("generation.run")
  const canEdit = capabilities.can("docs.write")

  const reviewQuery = useQuery(generationReviewQueryOptions(projectId))
  const pendingMergesQuery = useQuery(pendingMergesQueryOptions(projectId))
  const doxabotQuery = useQuery(projectDoxabotQueryOptions(projectId))
  const overviewQuery = useQuery(projectOverviewQueryOptions(projectId))
  const domainsQuery = useQuery(docsDomainsQueryOptions(projectId))
  const approvalsQuery = useQuery(approvalRequestListQueryOptions(projectId, "pending"))
  const mdxQuery = useQuery({ ...projectContentMdxReportQueryOptions(projectId, "main"), enabled: canEdit })

  const domains = domainsQuery.data?.domains ?? []
  const setup = useProjectSetup({
    projectId,
    project: workspace.project,
    generations: generations.generations,
    domains,
    canRun,
  })
  const { startGeneration, dialogProps } = useGenerationStartFlow(projectId, generations, {
    skipInstructionsOffer: setup.skippedInstructions,
  })

  const [connectOpen, setConnectOpen] = useState(false)

  // Finishes a connection that started before the GitHub App install.
  useEffect(() => {
    if (!canRun || !workspace.project || readPendingRepositoryConnect() !== projectId) return
    clearPendingRepositoryConnect()
    if (!workspace.project.githubRepositoryId) setConnectOpen(true)
  }, [canRun, projectId, workspace.project])

  // The skeleton is for the first load only (see `useIsFirstLoad`). Every
  // section below is part of the first frame, so none of them shifts the page.
  const isFirstLoad = useIsFirstLoad([
    { isPending: workspace.isLoading },
    { isPending: generations.isPending },
    { isPending: reviewQuery.isPending },
    { isPending: pendingMergesQuery.isPending },
    { isPending: overviewQuery.isPending },
    { isPending: domainsQuery.isPending },
    { isPending: approvalsQuery.isPending },
    { isPending: mdxQuery.isLoading },
    { isPending: setup.isLoading },
  ])
  // The dashboard loading screen of a `/dashboard` entry stays until now, so
  // the user never sees this page's skeleton after it.
  useDashboardPageReady(!isFirstLoad)
  if (isFirstLoad) return <ProjectOverviewSkeleton />

  const { project, latestJob } = workspace
  const overview = overviewQuery.data ?? null
  const activity = overview?.activity ?? []
  const isGenerating = generations.isStarting || generations.hasActiveGeneration
  const attentionItems = buildAttentionItems({
    projectId,
    review: reviewQuery.data ?? null,
    merges: pendingMergesQuery.data ?? [],
    doxabot: doxabotQuery.data ?? null,
    approvals: approvalsQuery.data?.requests ?? [],
    mdxPageCount: mdxQuery.data?.pages.length ?? 0,
    latestJob,
    domains,
    onGenerate: canRun ? () => void startGeneration() : null,
    isGenerating,
  })
  // A new project has nothing to report yet, so the checklist stands alone.
  const showActivity = !setup.isVisible || activity.length > 0 || overviewQuery.isError

  return (
    <PageBody className="max-w-5xl">
      <PageHeading
        label="Project"
        title={project?.name ?? "Overview"}
        actions={
          <Button variant="outline" asChild>
            <Link to="/dashboard/projects/$projectId/content" params={{ projectId }}>
              {canEdit ? "Edit content" : "View content"}
            </Link>
          </Button>
        }
      />

      {workspace.error ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>Could not load project</AlertTitle>
          <AlertDescription>{workspace.error}</AlertDescription>
        </Alert>
      ) : null}

      {generations.startError ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertDescription>{generations.startError}</AlertDescription>
        </Alert>
      ) : null}

      {project ? (
        <LiveSiteCard
          project={project}
          latestPublication={overview?.latestPublication ?? null}
          lastSyncedRevision={overview?.lastSyncedRevision ?? null}
          productionBranch={doxabotQuery.data?.productionBranch ?? null}
          defaultHostname={domains.find((domain) => domain.kind === "doxa_subdomain")?.hostname ?? null}
        />
      ) : null}

      <AttentionQueue items={attentionItems} />

      {setup.isVisible ? (
        <SetupChecklist
          projectId={projectId}
          steps={setup.steps}
          onConnectRepository={() => setConnectOpen(true)}
          onStartGeneration={() => void startGeneration()}
          isGenerating={isGenerating}
          onSkip={setup.skip}
          onHide={setup.hide}
        />
      ) : project?.publishedVersionId && attentionItems.length === 0 ? (
        <AttentionAllClear hasRepository={project.repositoryFullName !== null} />
      ) : null}

      {showActivity ? (
        <div className="flex flex-wrap items-start gap-6">
          <ActivityCard projectId={projectId} events={activity} failed={overviewQuery.isError} />
          <OpenPreviewsCard
            projectId={projectId}
            previews={overview?.openPreviews ?? []}
            repositoryFullName={project?.repositoryFullName ?? null}
          />
        </div>
      ) : null}

      <GenerationStartDialogs {...dialogProps} />
      <ConnectRepositoryDialog projectId={projectId} open={connectOpen} onOpenChange={setConnectOpen} />
    </PageBody>
  )
}
