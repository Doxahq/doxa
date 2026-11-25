import { useSyncExternalStore } from "react"

import type { AnalyticsSnapshot } from "~/lib/analytics/analytics-controller"
import { browserAnalytics } from "~/lib/analytics/browser-analytics"

/** The controller's answers, for the banner and the Privacy choices dialog. The server sees the empty start. */
export function useAnalyticsSnapshot(): AnalyticsSnapshot {
  return useSyncExternalStore(browserAnalytics.subscribe, browserAnalytics.getSnapshot, browserAnalytics.getSnapshot)
}
