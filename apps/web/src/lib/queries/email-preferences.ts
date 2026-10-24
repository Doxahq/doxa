import { queryOptions } from "@tanstack/react-query"

import { getEmailPreferences } from "~/lib/email-preferences-api"

export const emailPreferencesQueryKeys = {
  all: ["email-preferences"] as const,
}

/** Preferences change only from the settings page and from unsubscribe links. */
export function emailPreferencesQueryOptions() {
  return queryOptions({
    queryKey: emailPreferencesQueryKeys.all,
    queryFn: getEmailPreferences,
    staleTime: 60_000,
  })
}
