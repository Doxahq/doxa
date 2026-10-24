import type { DocsPreviewVisibility } from "@doxahq/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { getErrorMessage } from "~/lib/errors"
import {
  dashboardQueryKeys,
  projectPreviewVisibilityQueryOptions,
} from "~/lib/queries/dashboard"
import { updateProjectPreviewVisibility } from "~/lib/platform-api"

export function useProjectPreviewVisibility(projectId: string) {
  const queryClient = useQueryClient()
  const visibilityQuery = useQuery(
    projectPreviewVisibilityQueryOptions(projectId),
  )
  const updateMutation = useMutation({
    mutationFn: (previewVisibility: DocsPreviewVisibility) =>
      updateProjectPreviewVisibility(projectId, { previewVisibility }),
    onSuccess: (setting) => {
      queryClient.setQueryData(
        dashboardQueryKeys.previewVisibility(projectId),
        setting,
      )
    },
  })

  return {
    previewVisibility:
      visibilityQuery.data?.previewVisibility ?? null,
    isLoading: visibilityQuery.isPending,
    isSaving: updateMutation.isPending,
    error: visibilityQuery.error
      ? getErrorMessage(
          visibilityQuery.error,
          "Failed to load generation preview access.",
        )
      : null,
    update: updateMutation.mutateAsync,
  }
}
