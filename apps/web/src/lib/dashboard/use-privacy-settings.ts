import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { PrivacySettings } from "@doxahq/contracts/privacy-settings"

import { browserAnalytics } from "~/lib/analytics/browser-analytics"
import { getErrorMessage } from "~/lib/errors"
import { updatePrivacySettings } from "~/lib/privacy-settings-api"
import { privacySettingsQueryKeys, privacySettingsQueryOptions } from "~/lib/queries/privacy-settings"

/**
 * The Product analytics switch of Account settings. It changes at once and
 * rolls back when the save fails. After the save, this browser follows the
 * account's answer without a reload.
 */
export function usePrivacySettings() {
  const queryClient = useQueryClient()
  const query = useQuery(privacySettingsQueryOptions())
  const update = useMutation({
    mutationFn: updatePrivacySettings,
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: privacySettingsQueryKeys.all })
      const previous = queryClient.getQueryData<PrivacySettings>(privacySettingsQueryKeys.all)
      queryClient.setQueryData(privacySettingsQueryKeys.all, input)
      return { previous }
    },
    onError: (_error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(privacySettingsQueryKeys.all, context.previous)
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(privacySettingsQueryKeys.all, settings)
      browserAnalytics.update({ accountOptedOut: !settings.productAnalytics })
    },
  })

  return {
    productAnalytics: query.data?.productAnalytics ?? null,
    isLoading: query.isPending,
    loadError: query.error ? getErrorMessage(query.error, "The privacy settings could not be loaded.") : null,
    setProductAnalytics: (productAnalytics: boolean) => update.mutate({ productAnalytics }),
    saveError: update.error ? getErrorMessage(update.error, "The privacy setting could not be saved.") : null,
  }
}
