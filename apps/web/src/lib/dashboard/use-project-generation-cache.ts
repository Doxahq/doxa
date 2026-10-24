import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { getErrorMessage } from "~/lib/errors"
import {
  dashboardQueryKeys,
  projectGenerationCacheQueryOptions,
} from "~/lib/queries/dashboard"
import { clearProjectGenerationCache } from "~/lib/platform-api"

export function useProjectGenerationCache(projectId: string) {
  const queryClient = useQueryClient()
  const cacheQuery = useQuery(projectGenerationCacheQueryOptions(projectId))
  const clearMutation = useMutation({
    mutationFn: () => clearProjectGenerationCache(projectId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: dashboardQueryKeys.generationCache(projectId),
        exact: true,
      })
    },
  })

  return {
    cache: cacheQuery.data ?? null,
    isLoading: cacheQuery.isPending,
    isClearing: clearMutation.isPending,
    error: cacheQuery.error
      ? getErrorMessage(
          cacheQuery.error,
          "Failed to load generation cache status.",
        )
      : null,
    clear: clearMutation.mutateAsync,
  }
}
