import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { GenerationDetailDto, GenerationStartResultDto, GenerationsPageDto } from "@doxahq/contracts"
import type { InfiniteData } from "@tanstack/react-query"

import {
  cacheStartedGeneration,
  mergeGenerationIntoPages,
  mergeLatestJob,
  withRerunId,
} from "~/lib/dashboard/cache"
import { getGenerationDurationMs } from "~/lib/dashboard/generation-model"
import { useGenerationStreamStatus } from "~/lib/dashboard/generation-stream-context"
import { isTerminalJob } from "~/lib/dashboard/model"
import { getErrorMessage } from "~/lib/errors"
import {
  dashboardQueryKeys,
  projectGenerationEventsQueryOptions,
  projectGenerationQueryOptions,
  type ProjectDetail,
} from "~/lib/queries/dashboard"
import {
  cancelProjectGeneration,
  deleteProjectGeneration,
  promoteProjectGeneration,
  rerunProjectGeneration,
  resumeProjectGeneration,
  type GenerationStartOptions,
} from "~/lib/platform-api"

const GENERATION_POLL_INTERVAL_MS = 2_500

export function useProjectGeneration(projectId: string, generationId: string) {
  const queryClient = useQueryClient()
  const [now, setNow] = useState(() => Date.now())
  const streamStatus = useGenerationStreamStatus(generationId)
  // Poll whenever the stream is not actively delivering. "connecting" can hang
  // behind a proxy that buffers SSE, and "complete" ends the stream. Without
  // this, a non-terminal generation has no refresh source at all.
  const shouldPoll = streamStatus !== "live"
  const generationQuery = useQuery({
    ...projectGenerationQueryOptions(projectId, generationId),
    refetchInterval: ({ state }) => {
      const generation = state.data
      return shouldPoll && generation && !isTerminalJob(generation)
        ? GENERATION_POLL_INTERVAL_MS
        : false
    },
  })
  const generation = generationQuery.data ?? null
  const cancelMutation = useMutation({
    mutationFn: () => cancelProjectGeneration(projectId, generationId),
    onSuccess: (cancelled) => {
      queryClient.setQueryData(
        dashboardQueryKeys.generation(projectId, generationId),
        cancelled,
      )
      queryClient.setQueryData<InfiniteData<GenerationsPageDto> | undefined>(
        dashboardQueryKeys.generations(projectId),
        (data) => mergeGenerationIntoPages(data, cancelled),
      )
      queryClient.setQueryData<ProjectDetail | undefined>(
        dashboardQueryKeys.project(projectId),
        (project) => mergeLatestJob(project, cancelled),
      )
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: dashboardQueryKeys.generation(projectId, generationId),
        }),
        queryClient.invalidateQueries({
          queryKey: dashboardQueryKeys.generationEvents(projectId, generationId),
        }),
        queryClient.invalidateQueries({
          queryKey: dashboardQueryKeys.generations(projectId),
        }),
        queryClient.invalidateQueries({
          queryKey: dashboardQueryKeys.project(projectId),
        }),
        queryClient.invalidateQueries({
          queryKey: dashboardQueryKeys.summary(),
        }),
      ])
    },
  })
  const promoteMutation = useMutation({
    mutationFn: () =>
      promoteProjectGeneration(projectId, generationId),
    onSuccess: async (promoted) => {
      queryClient.setQueryData(
        dashboardQueryKeys.generation(projectId, generationId),
        promoted,
      )
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: dashboardQueryKeys.project(projectId),
        }),
        queryClient.invalidateQueries({
          queryKey: dashboardQueryKeys.domains(projectId),
        }),
      ])
    },
  })
  const deleteMutation = useMutation({
    mutationFn: () =>
      deleteProjectGeneration(projectId, generationId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: dashboardQueryKeys.generations(projectId),
        }),
        queryClient.invalidateQueries({
          queryKey: dashboardQueryKeys.project(projectId),
        }),
      ])
    },
  })
  const rerunMutation = useMutation({
    mutationFn: (options: GenerationStartOptions) =>
      rerunProjectGeneration(projectId, generationId, options),
    onSuccess: (result) => {
      if (result.outcome === "confirmation_required") return
      if (result.outcome !== "started") {
        cacheStartedGeneration(queryClient, projectId, result.job)
        return
      }
      // The two runs link to each other, so each page shows the link at once.
      cacheStartedGeneration(queryClient, projectId, result.job, { rerunOfId: generationId })
      queryClient.setQueryData<GenerationDetailDto | undefined>(
        dashboardQueryKeys.generation(projectId, generationId),
        (detail) => withRerunId(detail, result.job.id),
      )
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.generations(projectId) }),
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.project(projectId) }),
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.summary() }),
        // The failed run records the run that replaced it.
        queryClient.invalidateQueries({
          queryKey: dashboardQueryKeys.generation(projectId, generationId),
        }),
        queryClient.invalidateQueries({
          queryKey: dashboardQueryKeys.generationEvents(projectId, generationId),
        }),
      ])
    },
  })
  const resumeMutation = useMutation({
    mutationFn: () => resumeProjectGeneration(projectId, generationId),
    onSuccess: (resumed) => {
      queryClient.setQueryData(dashboardQueryKeys.generation(projectId, generationId), resumed)
      queryClient.setQueryData<ProjectDetail | undefined>(
        dashboardQueryKeys.project(projectId),
        (project) => mergeLatestJob(project, resumed),
      )
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.generations(projectId) }),
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.project(projectId) }),
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.summary() }),
        queryClient.invalidateQueries({
          queryKey: dashboardQueryKeys.generationEvents(projectId, generationId),
        }),
      ])
    },
  })
  const eventsQuery = useQuery({
    ...projectGenerationEventsQueryOptions(projectId, generationId),
    enabled: Boolean(generation),
    refetchInterval: shouldPoll && generation && !isTerminalJob(generation)
      ? GENERATION_POLL_INTERVAL_MS
      : false,
  })

  useEffect(() => {
    if (!generation || isTerminalJob(generation)) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [generation])

  const events = eventsQuery.data ?? []
  const queryError = generationQuery.error ?? eventsQuery.error

  async function cancel(): Promise<boolean> {
    if (cancelMutation.isPending || !generation || isTerminalJob(generation)) {
      return false
    }
    return cancelMutation.mutateAsync().then(() => true).catch(() => false)
  }

  async function promote(): Promise<boolean> {
    if (promoteMutation.isPending || !generation?.actions.canPromote) {
      return false
    }
    return promoteMutation.mutateAsync().then(() => true).catch(() => false)
  }

  /** Starts this failed generation again. Null when the request failed. */
  async function rerun(options: GenerationStartOptions = {}): Promise<GenerationStartResultDto | null> {
    if (rerunMutation.isPending) return null
    return rerunMutation.mutateAsync(options).catch(() => null)
  }

  /** Continues this failed generation from the step that failed. */
  async function resume(): Promise<boolean> {
    if (resumeMutation.isPending || !generation?.actions.canResume) return false
    return resumeMutation.mutateAsync().then(() => true).catch(() => false)
  }

  async function remove(): Promise<boolean> {
    if (deleteMutation.isPending || !generation?.actions.canDelete) {
      return false
    }
    return deleteMutation.mutateAsync().then(() => true).catch(() => false)
  }

  return {
    generation,
    events,
    durationMs: generation ? getGenerationDurationMs(generation, now) : 0,
    isPending: generationQuery.isPending,
    isRefreshing: generationQuery.isFetching || eventsQuery.isFetching,
    streamStatus,
    cancel,
    resetCancel: cancelMutation.reset,
    isCancelling: cancelMutation.isPending,
    cancelError: cancelMutation.error
      ? getErrorMessage(cancelMutation.error, "Failed to cancel generation. Try again.")
      : null,
    promote,
    isPromoting: promoteMutation.isPending,
    promoteError: promoteMutation.error
      ? getErrorMessage(
          promoteMutation.error,
          "Failed to promote generation. Try again.",
        )
      : null,
    rerun,
    isRerunning: rerunMutation.isPending,
    rerunError: rerunMutation.error
      ? getErrorMessage(rerunMutation.error, "Failed to run the generation again. Try again.")
      : null,
    resume,
    isResuming: resumeMutation.isPending,
    resumeError: resumeMutation.error
      ? getErrorMessage(resumeMutation.error, "Failed to continue the generation. Try again.")
      : null,
    remove,
    isDeleting: deleteMutation.isPending,
    deleteError: deleteMutation.error
      ? getErrorMessage(
          deleteMutation.error,
          "Failed to delete generation. Try again.",
        )
      : null,
    error: queryError
      ? getErrorMessage(queryError, "Failed to load this generation.")
      : null,
  }
}
