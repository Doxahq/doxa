import { queryOptions } from "@tanstack/react-query"

import { ANALYTICS_CONFIG_PATH, analyticsConfigSchema, type AnalyticsConfig } from "~/lib/analytics/analytics-config"

export const analyticsConfigQueryKeys = {
  all: ["analytics-config"] as const,
}

/** Same-origin and uncached: the answer depends on the visitor's country. */
export async function fetchAnalyticsConfig(): Promise<AnalyticsConfig> {
  const response = await fetch(ANALYTICS_CONFIG_PATH, { headers: { accept: "application/json" } })
  if (!response.ok) throw new Error(`The analytics config answered ${response.status}.`)
  return analyticsConfigSchema.parse(await response.json())
}

/** One answer per page load: the region and the PostHog connection do not change while the page is open. */
export function analyticsConfigQueryOptions() {
  return queryOptions({
    queryKey: analyticsConfigQueryKeys.all,
    queryFn: fetchAnalyticsConfig,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: 1,
  })
}
