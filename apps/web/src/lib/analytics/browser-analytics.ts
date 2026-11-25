import type { AnalyticsConsentChoice } from "@doxahq/analytics/browser"

import { AnalyticsController, type AnalyticsSdk } from "~/lib/analytics/analytics-controller"
import { createConsentStore } from "~/lib/analytics/consent-store"
import { getApiUrl } from "~/lib/platform-api"

/** The API host, so PostHog's tracing headers link a browser session to the API's events. */
function apiHostname(): string[] {
  try {
    return [new URL(getApiUrl("/")).hostname]
  } catch {
    return []
  }
}

/** posthog-js loads after the first paint, and only on a page that may send something. */
async function loadPostHog(): Promise<AnalyticsSdk> {
  const { posthog } = await import("posthog-js")
  return posthog
}

/** The one analytics controller of the page. Nothing loads on the server. */
export const browserAnalytics = new AnalyticsController({
  loadSdk: loadPostHog,
  tracingHosts: apiHostname(),
  isBrowser: typeof window !== "undefined",
})

export const analyticsConsentStore = createConsentStore()

/** The visitor's choice in the banner or in Privacy choices: stored, then applied at once. */
export function setAnalyticsConsent(choice: AnalyticsConsentChoice): void {
  analyticsConsentStore.write(choice)
  browserAnalytics.setChoice(choice)
}

/** Sign-out: the next person in this browser gets a new anonymous ID. */
export function resetAnalyticsPerson(): void {
  browserAnalytics.signOut()
}
