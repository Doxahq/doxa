import { Link } from "@tanstack/react-router"
import { Loader2, Play } from "lucide-react"

import { GenerationStartConfirmationDialog } from "~/components/dashboard/generation-start-confirmation-dialog"
import { Button } from "~/components/ui/button"
import { useGenerationStarter } from "~/lib/dashboard/use-generation-starter"
import { useProjectGenerations } from "~/lib/dashboard/use-project-generations"

/** The Doxabot page header actions: open the generations, or start one as the Generations page does. */
export function DoxabotPageActions({ projectId, canRun }: { projectId: string; canRun: boolean }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" asChild>
        <Link to="/dashboard/projects/$projectId/generations" params={{ projectId }}>
          View generations
        </Link>
      </Button>
      {canRun ? <RunGenerationButton projectId={projectId} /> : null}
    </div>
  )
}

function RunGenerationButton({ projectId }: { projectId: string }) {
  const generations = useProjectGenerations(projectId)
  const { startGeneration, confirmationDialogProps } = useGenerationStarter(projectId, generations)
  const isBusy = generations.isStarting || generations.hasActiveGeneration

  return (
    <>
      <Button onClick={() => void startGeneration()} disabled={isBusy}>
        {isBusy ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Play aria-hidden="true" />}
        {generations.isStarting ? "Starting…" : generations.hasActiveGeneration ? "Generating…" : "Run generation"}
      </Button>
      <GenerationStartConfirmationDialog {...confirmationDialogProps} />
    </>
  )
}
