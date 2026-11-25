import { useEffect } from "react"
import { useQuery } from "@tanstack/react-query"

import { ANALYTICS_CONSENT_STORAGE_KEY, parseConsentChoice } from "~/lib/analytics/consent-store"
import { analyticsConsentStore, browserAnalytics } from "~/lib/analytics/browser-analytics"
import { analyticsConfigQueryOptions } from "~/lib/queries/analytics-config"

/**
 * Feeds the page's analytics controller from the root: the config route's
 * answer and the visitor's stored choice. Both arrive after the first paint,
 * so the page never waits for analytics. A choice made in another tab applies
 * here too.
 */
export function useAnalyticsBootstrap(): void {
  const config = useQuery(analyticsConfigQueryOptions())

  useEffect(() => {
    browserAnalytics.setChoice(analyticsConsentStore.read())
    function onStorage(event: StorageEvent) {
      if (event.key === ANALYTICS_CONSENT_STORAGE_KEY) browserAnalytics.setChoice(parseConsentChoice(event.newValue))
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  useEffect(() => {
    if (config.data) {
      browserAnalytics.setConfig({ consentRequired: config.data.consentRequired, connection: config.data.posthog })
    } else if (config.isError) {
      // No answer means no key: analytics stays off, and the banner never shows.
      browserAnalytics.setConfig({ consentRequired: true, connection: null })
    }
  }, [config.data, config.isError])
}
