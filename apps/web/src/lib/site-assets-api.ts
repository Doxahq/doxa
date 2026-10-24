import {
  siteAssetUploadResponseSchema,
  type SiteAssetUploadResponse,
} from "@doxahq/contracts/site-assets"
import type { SiteAssetKind } from "@doxahq/site-config"

import { createApiError } from "~/lib/api-errors"
import { apiFetch, getApiRequestHeaders, getApiUrl } from "~/lib/platform-api"

// Kept apart from platform-api.ts: the upload schema brings the site config
// package, and only the lazily loaded settings dialog needs it.

/**
 * Uploads one logo, favicon, or Open Graph image for the project's docs site.
 *
 * The server detects the type from the file bytes and sanitizes SVG files, so
 * the response is the source of truth for the stored type and any warnings.
 */
export async function uploadSiteAsset(
  projectId: string,
  kind: SiteAssetKind,
  file: Blob,
): Promise<SiteAssetUploadResponse> {
  const body = new FormData()
  body.set("kind", kind)
  body.set("file", file)
  const result = await apiFetch<unknown>(
    `/projects/${encodeURIComponent(projectId)}/assets`,
    { method: "POST", body },
  )
  return siteAssetUploadResponseSchema.parse(result)
}

/**
 * Loads an uploaded asset through the authenticated preview route.
 *
 * Draft assets are not public, and an `<img>` cannot send the development
 * user header, so the dashboard reads the bytes and shows an object URL.
 */
export async function fetchSiteAssetPreview(projectId: string, hash: string): Promise<Blob> {
  const response = await fetch(
    getApiUrl(`/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(hash)}`),
    { credentials: "include", headers: getApiRequestHeaders() },
  )
  if (!response.ok) {
    throw createApiError(response.status, await response.json().catch(() => null))
  }
  return response.blob()
}
