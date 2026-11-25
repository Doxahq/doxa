import { queryOptions } from "@tanstack/react-query"

import { getPrivacySettings } from "~/lib/privacy-settings-api"

export const privacySettingsQueryKeys = {
  all: ["privacy-settings"] as const,
}

/** The settings change only from Account settings, in this tab or another one. */
export function privacySettingsQueryOptions() {
  return queryOptions({
    queryKey: privacySettingsQueryKeys.all,
    queryFn: getPrivacySettings,
    staleTime: 60_000,
  })
}
