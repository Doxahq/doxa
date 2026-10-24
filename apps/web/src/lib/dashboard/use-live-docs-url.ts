import { useQuery } from "@tanstack/react-query"

import { projectDetailQueryOptions } from "~/lib/queries/dashboard"

/** The URL of the live docs site, or null before the first publish. */
export function useLiveDocsUrl(projectId: string): string | null {
  const detail = useQuery(projectDetailQueryOptions(projectId))
  return detail.data?.project.publishedVersionId ? detail.data.project.docsUrl : null
}
