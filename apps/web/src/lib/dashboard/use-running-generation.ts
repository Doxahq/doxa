import { useEffect, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"

import { useProjectGenerations } from "~/lib/dashboard/use-project-generations"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"

/**
 * The project's running generation, for a page that waits for its result.
 * When the generation ends, the project's data loads again, so the page shows
 * what the generation published without a reload.
 */
export function useRunningGeneration(projectId: string) {
  const queryClient = useQueryClient()
  const { activeGeneration, isPending } = useProjectGenerations(projectId)
  const runningId = activeGeneration?.id ?? null
  const previousRunningId = useRef(runningId)

  useEffect(() => {
    const generationEnded = previousRunningId.current !== null && runningId === null
    previousRunningId.current = runningId
    if (generationEnded) {
      void queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.project(projectId) })
    }
  }, [projectId, queryClient, runningId])

  return { runningGenerationId: runningId, isPending }
}
