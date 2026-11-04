import { queryOptions } from "@tanstack/react-query"

import { warmStatusPollInterval } from "~/lib/dashboard/docs-warm-status"
import { getDocsWarmStatus } from "~/lib/docs-warm-status-api"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"

export const docsWarmStatusQueryKeys = {
  /** One entry per publish: `publishedAt` is when its answer arrived. */
  publish: (projectId: string, publishedAt: number) =>
    [...dashboardQueryKeys.project(projectId), "warm-status", publishedAt] as const,
}

/** The regional warm progress after a publish (M45b), polled while it runs. */
export function docsWarmStatusQueryOptions(projectId: string, publishedAt: number) {
  return queryOptions({
    queryKey: docsWarmStatusQueryKeys.publish(projectId, publishedAt),
    queryFn: () => getDocsWarmStatus(projectId),
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      query.state.status === "error"
        ? false
        : warmStatusPollInterval(query.state.data, publishedAt, Date.now()),
  })
}
