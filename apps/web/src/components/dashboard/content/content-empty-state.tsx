import { Link } from "@tanstack/react-router"

import { EmptyState } from "~/components/dashboard/dashboard-header"
import { Button } from "~/components/ui/button"
import { Skeleton } from "~/components/ui/skeleton"
import { useRunningGeneration } from "~/lib/dashboard/use-running-generation"

/** The content page of a site without pages: a generation is writing them, or none exists yet. */
export function ContentEmptyState({ projectId }: { projectId: string }) {
  const { runningGenerationId, isPending } = useRunningGeneration(projectId)

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4 sm:p-6">
      {isPending ? (
        <ContentEmptySkeleton />
      ) : runningGenerationId === null ? (
        <EmptyState
          title="No documentation yet"
          description="Generate documentation first. The editor works on the published version."
        />
      ) : (
        <EmptyState
          title="Generating your docs"
          description="Doxabot is writing your docs. Your pages appear here when the generation is done."
          action={(
            <Button variant="outline" size="sm" asChild>
              <Link
                to="/dashboard/projects/$projectId/generations/$generationId"
                params={{ projectId, generationId: runningGenerationId }}
              >
                View generation
              </Link>
            </Button>
          )}
        />
      )}
    </div>
  )
}

/** The title and description of `EmptyState`, in the place they appear. */
function ContentEmptySkeleton() {
  return (
    <div
      aria-hidden="true"
      className="surface-card mx-auto flex w-full max-w-md flex-col items-center gap-1.5 px-8 py-12"
    >
      <Skeleton className="h-5 w-48" />
      <Skeleton className="h-10 w-full" />
    </div>
  )
}
