import {
  docsBranchAssetUploadResponseSchema,
  type DocsBranchAssetUploadResponse,
} from "@doxahq/contracts/docs-assets"
import type { BranchRef } from "@doxahq/contracts/docs-branches"

import { createApiError } from "~/lib/api-errors"
import { apiFetch, getApiRequestHeaders, getApiUrl } from "~/lib/platform-api"

function branchAssetsPath(projectId: string, branch: BranchRef): string {
  return `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branch)}/assets`
}

/**
 * Adds an image to the branch. `main` adds it to the user's working copy of
 * `main`, like a page edit. The server detects the type from the bytes and
 * returns the path the page links to, which can differ from the file name.
 */
export async function uploadBranchAsset(
  projectId: string,
  branch: BranchRef,
  file: File,
): Promise<DocsBranchAssetUploadResponse> {
  const body = new FormData()
  body.set("file", file)
  const result = await apiFetch<unknown>(branchAssetsPath(projectId, branch), { method: "POST", body })
  return docsBranchAssetUploadResponseSchema.parse(result)
}

/**
 * Loads an image as the branch sees it. An unpublished image is not on the
 * docs host yet, and an `<img>` cannot send the development user header, so
 * the editor reads the bytes and shows an object URL.
 */
export async function fetchBranchAsset(projectId: string, branch: BranchRef, name: string): Promise<Blob> {
  const response = await fetch(getApiUrl(`${branchAssetsPath(projectId, branch)}/${encodeURIComponent(name)}`), {
    credentials: "include",
    headers: getApiRequestHeaders(),
  })
  if (!response.ok) {
    throw createApiError(response.status, await response.json().catch(() => null))
  }
  return response.blob()
}
