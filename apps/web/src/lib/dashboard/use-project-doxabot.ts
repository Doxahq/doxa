import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { UpdateDoxabotSettingsInput } from "@doxahq/contracts"

import { getErrorMessage } from "~/lib/errors"
import {
  dashboardQueryKeys,
  projectDoxabotQueryOptions,
} from "~/lib/queries/dashboard"
import { updateProjectDoxabotSettings } from "~/lib/platform-api"

export function useProjectDoxabot(projectId: string) {
  const queryClient = useQueryClient()
  const settingsQuery = useQuery(projectDoxabotQueryOptions(projectId))
  const updateMutation = useMutation({
    mutationFn: (changes: UpdateDoxabotSettingsInput) =>
      updateProjectDoxabotSettings(projectId, changes),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: dashboardQueryKeys.doxabot(projectId),
        exact: true,
      })
    },
  })

  return {
    settings: settingsQuery.data ?? null,
    isLoading: settingsQuery.isPending,
    isSaving: updateMutation.isPending,
    error: settingsQuery.error
      ? getErrorMessage(
          settingsQuery.error,
          "Failed to load Doxabot settings.",
        )
      : null,
    updateEnabled: (enabled: boolean) => updateMutation.mutateAsync({ enabled }),
    /** Saves only the settings that change, such as the merge trigger. */
    update: updateMutation.mutateAsync,
  }
}
