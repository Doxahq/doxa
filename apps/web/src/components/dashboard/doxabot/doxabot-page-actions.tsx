import { Link } from "@tanstack/react-router"
import { Loader2, Play } from "lucide-react"

import { GenerationStartDialogs } from "~/components/dashboard/generation-start-dialogs"
import { Button } from "~/components/ui/button"
import { useGenerationStartFlow } from "~/lib/dashboard/use-generation-start-flow"
import { useProjectGenerations } from "~/lib/dashboard/use-project-generations"

/**
 * The Doxabot page header actions: open the generations, or start one as the
 * Generations page does. For an account without the Doxa Agent (Free), the
 * start opens the Pro trial dialog (`useGenerationStartFlow`).
 */
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
  const { startGeneration, dialogProps } = useGenerationStartFlow(projectId, generations)
  const isBusy = generations.isStarting || generations.hasActiveGeneration

  return (
    <>
      <Button onClick={() => void startGeneration()} disabled={isBusy}>
        {isBusy ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Play aria-hidden="true" />}
        {generations.isStarting ? "Starting…" : generations.hasActiveGeneration ? "Generating…" : "Run generation"}
      </Button>
      <GenerationStartDialogs {...dialogProps} />
    </>
  )
}
