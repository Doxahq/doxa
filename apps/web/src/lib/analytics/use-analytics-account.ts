import { useEffect } from "react"
import { useQuery } from "@tanstack/react-query"

import type { AnalyticsPerson } from "~/lib/analytics/analytics-controller"
import { browserAnalytics } from "~/lib/analytics/browser-analytics"
import { privacySettingsQueryOptions } from "~/lib/queries/privacy-settings"

/**
 * Tells the page's analytics controller who is signed in and whether their
 * account turned analytics off. Until the account answers, the controller
 * starts nothing new. A failed answer counts as "on", the account default:
 * the API still drops every server event of a person who opted out.
 */
export function useAnalyticsAccount(person: AnalyticsPerson | null): void {
  const settings = useQuery({ ...privacySettingsQueryOptions(), enabled: person !== null })
  const personId = person?.id ?? null
  const email = person?.email ?? null

  useEffect(() => {
    if (personId === null) return
    browserAnalytics.update({ person: { id: personId, email } })
  }, [personId, email])

  const productAnalytics = settings.data?.productAnalytics
  useEffect(() => {
    if (personId === null) return
    if (productAnalytics !== undefined) browserAnalytics.update({ accountOptedOut: !productAnalytics })
    else if (settings.isError) browserAnalytics.update({ accountOptedOut: false })
    else browserAnalytics.update({ accountOptedOut: null })
  }, [personId, productAnalytics, settings.isError])
}
