import { queryOptions, skipToken } from "@tanstack/react-query"
import { docsAssetNameFromUrlPath } from "@doxahq/contracts/docs-assets"
import type { BranchRef } from "@doxahq/contracts/docs-branches"

import { fetchBranchAsset } from "~/lib/branch-assets-api"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"

export const branchAssetQueryKeys = {
  asset: (projectId: string, branch: BranchRef, name: string | null) =>
    [...dashboardQueryKeys.project(projectId), "branch-assets", branch, name] as const,
}

/**
 * An object URL for an image that a page links to as `/assets/{name}`, as the
 * branch sees it. Any other source needs no lookup and has no query.
 *
 * An upload never replaces the file behind a name (a name in use gets a
 * number suffix), so the URL is kept for the session.
 */
export function branchAssetQueryOptions(projectId: string, branch: BranchRef, src: string) {
  const name = docsAssetNameFromUrlPath(src)
  return queryOptions({
    queryKey: branchAssetQueryKeys.asset(projectId, branch, name),
    queryFn: name ? async () => URL.createObjectURL(await fetchBranchAsset(projectId, branch, name)) : skipToken,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  })
}
