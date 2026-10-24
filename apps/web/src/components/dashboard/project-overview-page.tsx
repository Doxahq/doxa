import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { AlertCircle, CheckCircle2, Github } from "lucide-react"

import {
  FieldList,
  FieldRow,
  PageBody,
  PageHeading,
} from "~/components/dashboard/dashboard-header"
import { ConnectRepositoryDialog } from "~/components/dashboard/connect-repository-dialog"
import { ConnectRepositoryWelcome } from "~/components/dashboard/connect-repository-welcome"
import { GenerationStartConfirmationDialog } from "~/components/dashboard/generation-start-confirmation-dialog"
import { GenerationWelcome } from "~/components/dashboard/generation-welcome"
import { JobStatusBadge } from "~/components/dashboard/dashboard-status"
import { ReviewWaitingBanner } from "~/components/dashboard/review/review-waiting-banner"
import { PendingMergesNote } from "~/components/dashboard/pending-merges-note"
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  getProjectPublicationLabel,
  getProjectPublicationState,
} from "~/lib/dashboard/model"
import {
  clearPendingRepositoryConnect,
  readPendingRepositoryConnect,
} from "~/lib/dashboard/pending-repository-connect"
import { useProjectBranch } from "~/lib/dashboard/project-branch-context"
import { useGenerationStarter } from "~/lib/dashboard/use-generation-starter"
import { useProjectCapabilities } from "~/lib/dashboard/use-project-capabilities"
import { useProjectGenerations } from "~/lib/dashboard/use-project-generations"
import { ProjectOverviewSkeleton } from "~/components/dashboard/skeletons/project-skeletons"
import { useProjectWorkspace } from "~/lib/dashboard/use-project-workspace"
import { useIsFirstLoad } from "~/lib/dashboard/use-first-load"
import { generationReviewQueryOptions } from "~/lib/queries/generation-review"
import { pendingMergesQueryOptions, projectDoxabotQueryOptions } from "~/lib/queries/dashboard"

export function ProjectOverviewPage({ projectId }: { projectId: string }) {
  const workspace = useProjectWorkspace(projectId)
  const generations = useProjectGenerations(projectId)
  const reviewQuery = useQuery(generationReviewQueryOptions(projectId))
  const pendingMergesQuery = useQuery(pendingMergesQueryOptions(projectId))
  const doxabotQuery = useQuery(projectDoxabotQueryOptions(projectId))
  const { startGeneration, confirmationDialogProps } = useGenerationStarter(projectId, generations)
  const branch = useProjectBranch()
  const hasRepository = Boolean(workspace.project?.githubRepositoryId)
  const showWelcome = workspace.project !== null && workspace.latestJob === null
  const [connectOpen, setConnectOpen] = useState(false)
  // Connecting a repository and starting a generation both need `generation.run`.
  const canRun = useProjectCapabilities(projectId).can("generation.run")
  const openConnect = canRun ? () => setConnectOpen(true) : null

  // Finishes a connection that started before the GitHub App install.
  useEffect(() => {
    if (!canRun || !workspace.project || readPendingRepositoryConnect() !== projectId) return
    clearPendingRepositoryConnect()
    if (!workspace.project.githubRepositoryId) setConnectOpen(true)
  }, [canRun, projectId, workspace.project])

  // The skeleton is for the first load only (see `useIsFirstLoad`).
  // The review banner is part of the first frame, so it never shifts the page.
  const isFirstLoad = useIsFirstLoad([
    { isPending: workspace.isLoading },
    { isPending: reviewQuery.isPending },
    { isPending: pendingMergesQuery.isPending },
  ])
  if (isFirstLoad) return <ProjectOverviewSkeleton />

  return (
    <PageBody>
      <PageHeading
        label="Project"
        title={workspace.project?.name ?? "Overview"}
        description={
          hasRepository || !workspace.project
            ? "Repository connection, publication state, and hosted documentation target."
            : "Publication state and hosted documentation target. This project has no repository yet."
        }
      />

      {workspace.error ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>Could not load project</AlertTitle>
          <AlertDescription>{workspace.error}</AlertDescription>
        </Alert>
      ) : null}

      {reviewQuery.data ? <ReviewWaitingBanner projectId={projectId} review={reviewQuery.data} /> : null}

      <PendingMergesNote
        merges={pendingMergesQuery.data ?? []}
        settings={doxabotQuery.data ?? null}
        onGenerate={canRun ? () => void startGeneration() : null}
      />

      {showWelcome && !hasRepository ? (
        <ConnectRepositoryWelcome projectId={projectId} onConnect={openConnect} />
      ) : null}

      {showWelcome && hasRepository ? (
        <div className="flex flex-col gap-4">
          {generations.startError ? (
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <AlertDescription>{generations.startError}</AlertDescription>
            </Alert>
          ) : null}
          <GenerationWelcome
            isStarting={generations.isStarting}
            isGenerating={generations.hasActiveGeneration}
            onStart={canRun ? () => void startGeneration() : null}
          />
        </div>
      ) : null}

      {workspace.project ? (
        <section className="flex flex-col gap-4">
          <FieldList>
            <FieldRow label="Status">
              <PublicationBadge publishedVersionId={workspace.project.publishedVersionId} />
            </FieldRow>
            <FieldRow label="Slug" mono>/{workspace.project.slug}</FieldRow>
            <FieldRow label="Current branch" mono>
              {branch.selectedBranch?.name ?? "main"}
            </FieldRow>
            <FieldRow label="Repository" mono={Boolean(workspace.project.repositoryFullName)}>
              {workspace.project.repositoryFullName ?? (
                <span className="flex flex-wrap items-center gap-3">
                  Not connected
                  {canRun ? (
                    <Button variant="outline" size="sm" onClick={() => setConnectOpen(true)}>
                      <Github aria-hidden="true" />
                      Connect repository
                    </Button>
                  ) : null}
                </span>
              )}
            </FieldRow>
            <FieldRow label="Docs target" mono={Boolean(workspace.project.docsUrl)}>
              {workspace.project.docsUrl ? (
                <a
                  href={workspace.project.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-link block truncate"
                >
                  {workspace.project.docsUrl}
                </a>
              ) : (
                "Not configured"
              )}
            </FieldRow>
            <FieldRow label="Latest generation">
              {workspace.latestJob ? (
                <JobStatusBadge status={workspace.latestJob.status} />
              ) : (
                "No generation yet"
              )}
            </FieldRow>
          </FieldList>
        </section>
      ) : null}

      <GenerationStartConfirmationDialog {...confirmationDialogProps} />
      <ConnectRepositoryDialog projectId={projectId} open={connectOpen} onOpenChange={setConnectOpen} />
    </PageBody>
  )
}

function PublicationBadge({ publishedVersionId }: { publishedVersionId: string | null }) {
  const state = getProjectPublicationState({ publishedVersionId })
  return (
    <Badge variant={state === "published" ? "success" : "muted"}>
      {state === "published" ? <CheckCircle2 aria-hidden="true" className="size-3" /> : null}
      {getProjectPublicationLabel(state)}
    </Badge>
  )
}
