import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { AlertCircle, ArrowRight, Clock3, Github, Loader2, Play } from "lucide-react"
import type { GenerationJobDto } from "@doxahq/contracts"

import { PageBody, PageHeading } from "~/components/dashboard/dashboard-header"
import { ConnectRepositoryDialog } from "~/components/dashboard/connect-repository-dialog"
import { ConnectRepositoryWelcome } from "~/components/dashboard/connect-repository-welcome"
import { GenerationStartDialogs } from "~/components/dashboard/generation-start-dialogs"
import { GenerationWelcome } from "~/components/dashboard/generation-welcome"
import { JobStatusBadge } from "~/components/dashboard/dashboard-status"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  formatGenerationDuration,
  getGenerationDurationMs,
  shortenGenerationId,
} from "~/lib/dashboard/generation-model"
import { useGenerationStartFlow } from "~/lib/dashboard/use-generation-start-flow"
import { useProjectCapabilities } from "~/lib/dashboard/use-project-capabilities"
import { useProjectGenerations } from "~/lib/dashboard/use-project-generations"
import { useProjectWorkspace } from "~/lib/dashboard/use-project-workspace"
import { useIsFirstLoad } from "~/lib/dashboard/use-first-load"
import { ProjectGenerationsSkeleton } from "~/components/dashboard/skeletons/project-skeletons"
import { generationReviewQueryOptions } from "~/lib/queries/generation-review"

const GENERATION_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

export function ProjectGenerationsPage({ projectId }: { projectId: string }) {
  const state = useProjectGenerations(projectId)
  const { startGeneration, dialogProps } = useGenerationStartFlow(projectId, state)
  const isEmpty = !state.isPending && !state.error && state.generations.length === 0
  const workspace = useProjectWorkspace(projectId)
  const needsRepository = workspace.project !== null && !workspace.project.githubRepositoryId
  const [connectOpen, setConnectOpen] = useState(false)
  const canRun = useProjectCapabilities(projectId).can("generation.run")
  const reviewJobId = useQuery(generationReviewQueryOptions(projectId)).data?.jobId ?? null

  // The skeleton is for the first load only (see `useIsFirstLoad`).
  const isFirstLoad = useIsFirstLoad([{ isPending: state.isPending }])
  if (isFirstLoad) return <ProjectGenerationsSkeleton />

  return (
    <PageBody className="max-w-4xl">
      <section className="flex flex-col gap-4">
        {isEmpty ? null : (
          <PageHeading
            label="Project"
            title="Generations"
            description="Every documentation generation for this project, newest first."
            actions={!canRun ? null : needsRepository ? (
              <Button onClick={() => setConnectOpen(true)}>
                <Github aria-hidden="true" />
                Connect repository
              </Button>
            ) : (
              <Button
                onClick={() => void startGeneration()}
                disabled={state.isStarting || state.hasActiveGeneration}
              >
                {state.isStarting || state.hasActiveGeneration ? (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                ) : (
                  <Play aria-hidden="true" />
                )}
                {state.isStarting ? "Starting…" : state.hasActiveGeneration ? "Generating…" : "Generate docs"}
              </Button>
            )}
          />
        )}

        {state.error || state.startError ? (
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertDescription>{state.startError ?? state.error}</AlertDescription>
          </Alert>
        ) : null}

        {state.generations.length > 0 ? (
          <GenerationList projectId={projectId} generations={state.generations} reviewJobId={reviewJobId} />
        ) : isEmpty && needsRepository ? (
          <ConnectRepositoryWelcome projectId={projectId} onConnect={canRun ? () => setConnectOpen(true) : null} />
        ) : isEmpty ? (
          <GenerationWelcome
            isStarting={state.isStarting}
            isGenerating={state.hasActiveGeneration}
            onStart={canRun ? () => void startGeneration() : null}
          />
        ) : null}

        {state.hasNextPage ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => void state.fetchNextPage()}
            disabled={state.isFetchingNextPage}
            className="self-center"
          >
            {state.isFetchingNextPage ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
            {state.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        ) : null}
      </section>

      <GenerationStartDialogs {...dialogProps} />
      <ConnectRepositoryDialog projectId={projectId} open={connectOpen} onOpenChange={setConnectOpen} />
    </PageBody>
  )
}

function GenerationList({
  projectId,
  generations,
  reviewJobId,
}: {
  projectId: string
  generations: GenerationJobDto[]
  /** The generation whose result waits in the open review. */
  reviewJobId: string | null
}) {
  return (
    <ol className="surface-card">
      {generations.map((generation, index) => (
        <li key={generation.id} className={index > 0 ? "border-t border-divider" : undefined}>
          <Link
            to="/dashboard/projects/$projectId/generations/$generationId"
            params={{ projectId, generationId: generation.id }}
            className="group grid min-h-20 gap-3 px-4 py-4 transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center focus-visible:-outline-offset-2"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <JobStatusBadge status={generation.status} />
                {generation.id === reviewJobId ? <Badge variant="warning">In review</Badge> : null}
                <span className="font-mono text-xs text-foreground">
                  {shortenGenerationId(generation.id)}
                </span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                <time dateTime={generation.createdAt}>
                  {GENERATION_DATE_FORMAT.format(new Date(generation.createdAt))}
                </time>
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 font-mono text-xs tabular-nums text-muted-foreground">
              <Clock3 aria-hidden="true" className="size-3.5" />
              {formatGenerationDuration(getGenerationDurationMs(generation))}
            </span>
            <ArrowRight aria-hidden="true" className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
          </Link>
        </li>
      ))}
    </ol>
  )
}
