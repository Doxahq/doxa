import { useMutation, useQuery } from "@tanstack/react-query"
import type { AssetRef, SiteAssetKind, ValidationIssue } from "@doxahq/site-config"

import { isApiValidationError } from "~/lib/api-errors"
import { getErrorMessage } from "~/lib/errors"
import { checkSiteAssetFile } from "~/lib/dashboard/site-asset-files"
import { uploadSiteAsset } from "~/lib/site-assets-api"
import { siteAssetPreviewQueryOptions } from "~/lib/queries/site-settings"

export type SiteAssetUploadResult =
  | { ok: true; ref: AssetRef; warnings: readonly ValidationIssue[] }
  | { ok: false; issues: readonly ValidationIssue[]; message: string | null }

/** Uploads one site asset, with the client pre-check first. */
export function useSiteAssetUpload(projectId: string) {
  const mutation = useMutation({
    mutationFn: (input: { kind: SiteAssetKind; file: File }) =>
      uploadSiteAsset(projectId, input.kind, input.file),
  })

  async function upload(kind: SiteAssetKind, file: File): Promise<SiteAssetUploadResult> {
    const precheck = checkSiteAssetFile(kind, file)
    if (precheck) return { ok: false, issues: [precheck], message: null }
    try {
      const result = await mutation.mutateAsync({ kind, file })
      return { ok: true, ref: result.ref, warnings: result.warnings ?? [] }
    } catch (error) {
      if (isApiValidationError(error)) return { ok: false, issues: error.issues, message: null }
      return { ok: false, issues: [], message: getErrorMessage(error, "The upload failed.") }
    }
  }

  return { upload, isUploading: mutation.isPending }
}

export function useSiteAssetPreview(projectId: string, ref: AssetRef | null) {
  return useQuery(siteAssetPreviewQueryOptions(projectId, ref))
}
