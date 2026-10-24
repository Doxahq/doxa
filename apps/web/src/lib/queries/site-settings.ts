import { queryOptions, skipToken } from "@tanstack/react-query"
import type { AssetRef } from "@doxahq/site-config"

import { fetchSiteAssetPreview } from "~/lib/site-assets-api"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"

export const siteSettingsQueryKeys = {
  assetPreview: (projectId: string, ref: AssetRef | null) =>
    [...dashboardQueryKeys.project(projectId), "site-assets", ref] as const,
}

export function assetHash(ref: AssetRef): string {
  return ref.slice("asset:".length)
}

/**
 * An object URL for an uploaded asset.
 *
 * Assets are addressed by content hash, so the bytes behind a reference never
 * change. The URL is cached for the whole session and never refetched.
 */
export function siteAssetPreviewQueryOptions(projectId: string, ref: AssetRef | null) {
  return queryOptions({
    queryKey: siteSettingsQueryKeys.assetPreview(projectId, ref),
    queryFn: ref
      ? async () => URL.createObjectURL(await fetchSiteAssetPreview(projectId, assetHash(ref)))
      : skipToken,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  })
}
