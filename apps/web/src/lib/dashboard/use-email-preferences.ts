import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { EmailNotificationCategory, EmailPreferences } from "@doxahq/contracts/email-preferences"

import { getErrorMessage } from "~/lib/errors"
import { updateEmailPreference } from "~/lib/email-preferences-api"
import { emailPreferencesQueryKeys, emailPreferencesQueryOptions } from "~/lib/queries/email-preferences"

/** The notification switches. A switch changes at once and rolls back when the save fails. */
export function useEmailPreferences() {
  const queryClient = useQueryClient()
  const query = useQuery(emailPreferencesQueryOptions())
  const update = useMutation({
    mutationFn: updateEmailPreference,
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: emailPreferencesQueryKeys.all })
      const previous = queryClient.getQueryData<EmailPreferences>(emailPreferencesQueryKeys.all)
      if (previous) queryClient.setQueryData(emailPreferencesQueryKeys.all, withPreference(previous, input))
      return { previous }
    },
    onError: (_error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(emailPreferencesQueryKeys.all, context.previous)
    },
    onSuccess: (preferences) => queryClient.setQueryData(emailPreferencesQueryKeys.all, preferences),
  })

  return {
    preferences: query.data?.preferences ?? null,
    isLoading: query.isPending,
    loadError: query.error ? getErrorMessage(query.error, "The email settings could not be loaded.") : null,
    setEnabled: (category: EmailNotificationCategory, enabled: boolean) => update.mutate({ category, enabled }),
    saveError: update.error ? getErrorMessage(update.error, "The email setting could not be saved.") : null,
  }
}

function withPreference(
  preferences: EmailPreferences,
  change: { category: EmailNotificationCategory; enabled: boolean },
): EmailPreferences {
  return {
    preferences: preferences.preferences.map((preference) =>
      preference.category === change.category ? { ...preference, enabled: change.enabled } : preference,
    ),
  }
}
