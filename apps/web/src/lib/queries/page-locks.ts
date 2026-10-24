import { queryOptions } from "@tanstack/react-query"

import { listPageLocks } from "~/lib/page-locks-api"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"

export const pageLockQueryKeys = {
  project: (projectId: string) => [...dashboardQueryKeys.project(projectId), "page-locks"] as const,
}

export function pageLocksQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: pageLockQueryKeys.project(projectId),
    queryFn: () => listPageLocks(projectId),
    staleTime: 30_000,
    retry: false,
  })
}
