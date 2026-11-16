import { queryOptions } from "@tanstack/react-query"

import { getDocsExportStatus } from "~/lib/docs-export-api"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"

export const docsExportQueryKeys = {
  status: (projectId: string) => [...dashboardQueryKeys.project(projectId), "export-status"] as const,
}

/** Read again before each download: the quota and the published version change. */
export function docsExportStatusQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: docsExportQueryKeys.status(projectId),
    queryFn: () => getDocsExportStatus(projectId),
    staleTime: 0,
    retry: false,
  })
}
