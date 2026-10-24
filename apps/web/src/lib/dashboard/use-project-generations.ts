import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import {
  ACTIVE_GENERATION_MESSAGE,
  type GenerationStartResultDto,
} from "@doxahq/contracts"

import { cacheStartedGeneration } from "~/lib/dashboard/cache"
import { dedupeGenerations } from "~/lib/dashboard/generation-model"
import { useGenerationStreamStatus } from "~/lib/dashboard/generation-stream-context"
import { isTerminalJob } from "~/lib/dashboard/model"
import { getErrorMessage } from "~/lib/errors"
import {
  dashboardQueryKeys,
  projectGenerationsQueryOptions,
  type ProjectDetail,
} from "~/lib/queries/dashboard"
import { startGeneration, type GenerationStartOptions } from "~/lib/platform-api"

const GENERATION_POLL_INTERVAL_MS = 2_500

export function useProjectGenerations(projectId: string) {
  const queryClient = useQueryClient()
  const latestKnownGeneration = queryClient.getQueryData<ProjectDetail>(
    dashboardQueryKeys.project(projectId),
  )?.latestJob ?? null
  const streamStatus = useGenerationStreamStatus(latestKnownGeneration?.id ?? null)
  // Poll whenever the stream is not actively delivering. "connecting" can hang
  // behind a proxy that buffers SSE, and "complete" ends the stream. Without
  // this, a non-terminal generation has no refresh source at all.
  const shouldPoll = streamStatus !== "live"
  const generationsQuery = useInfiniteQuery({
    ...projectGenerationsQueryOptions(projectId),
    refetchInterval: ({ state }) => {
      const hasActiveGeneration = state.data?.pages.some((page) => (
        page.generations.some((generation) => !isTerminalJob(generation))
      ))
      return shouldPoll && hasActiveGeneration ? GENERATION_POLL_INTERVAL_MS : false
    },
  })
  const startMutation = useMutation({
    mutationFn: (options: GenerationStartOptions) =>
      startGeneration(projectId, options),
    onSuccess: (result) => {
      if (result.outcome === "confirmation_required") return
      cacheStartedGeneration(queryClient, projectId, result.job)
    },
    onSettled: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.generations(projectId) }),
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.project(projectId) }),
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.summary() }),
        ...(result
          && result.job
          ? [queryClient.invalidateQueries({
              queryKey: dashboardQueryKeys.generation(projectId, result.job.id),
            })]
          : []),
      ])
    },
  })
  const generations = dedupeGenerations(generationsQuery.data?.pages ?? [])
  const activeGeneration = generations.find((generation) => !isTerminalJob(generation)) ?? null
  const hasActiveGeneration = activeGeneration !== null

  async function start(options: GenerationStartOptions = {}): Promise<GenerationStartResultDto | null> {
    if (startMutation.isPending) return null
    // The client already knows about the running generation. Report the same
    // result that the server sends, so the caller shows one message.
    if (activeGeneration) {
      return {
        job: activeGeneration,
        outcome: "already_active",
        message: ACTIVE_GENERATION_MESSAGE,
      }
    }
    return startMutation.mutateAsync(options).catch(() => null)
  }

  return {
    generations,
    start,
    isPending: generationsQuery.isPending,
    isFetching: generationsQuery.isFetching,
    isFetchingNextPage: generationsQuery.isFetchingNextPage,
    hasNextPage: generationsQuery.hasNextPage,
    fetchNextPage: generationsQuery.fetchNextPage,
    isStarting: startMutation.isPending,
    hasActiveGeneration,
    error: generationsQuery.error
      ? getErrorMessage(generationsQuery.error, "Failed to load generations.")
      : null,
    startError: startMutation.error
      ? getErrorMessage(startMutation.error, "Failed to start generation.")
      : null,
  }
}
