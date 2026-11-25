import { createContext, useContext, useMemo, type ReactNode } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { docsAssetNameFromUrlPath } from "@doxahq/contracts/docs-assets"
import type { BranchRef } from "@doxahq/contracts/docs-branches"
import { toast } from "sonner"

import { uploadBranchAsset } from "~/lib/branch-assets-api"
import { reportBillingDenial } from "~/lib/dashboard/billing-denials"
import { getDocsBranchErrorMessage } from "~/lib/dashboard/docs-branch-errors"
import type { ImageUploader } from "~/lib/editor/image-upload"
import { branchAssetQueryKeys, branchAssetQueryOptions } from "~/lib/queries/branch-assets"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"
import { docsBranchQueryKeys } from "~/lib/queries/docs-branches"

interface EditorAssets {
  projectId: string
  branch: BranchRef
  uploader: ImageUploader
}

const EditorAssetsContext = createContext<EditorAssets | null>(null)

/**
 * The branch that the content editor adds images to and reads them from.
 * Without it, the editor and the preview show `/assets/…` paths as they are
 * and cannot upload.
 */
export function EditorAssetsProvider({
  projectId,
  branch,
  children,
}: {
  projectId: string
  branch: BranchRef
  children: ReactNode
}) {
  const queryClient = useQueryClient()
  const value = useMemo<EditorAssets>(
    () => ({
      projectId,
      branch,
      uploader: {
        async upload(file) {
          const result = await uploadBranchAsset(projectId, branch, file)
          // The editor shows the uploaded bytes at once, without a read back.
          queryClient.setQueryData(
            branchAssetQueryKeys.asset(projectId, branch, docsAssetNameFromUrlPath(result.path)),
            URL.createObjectURL(file),
          )
          // The image is a branch change: the publish menu and the branch
          // list count it. The open page source is left alone.
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.content(projectId, branch), exact: true }),
            queryClient.invalidateQueries({ queryKey: docsBranchQueryKeys.status(projectId, branch) }),
            queryClient.invalidateQueries({ queryKey: docsBranchQueryKeys.list(projectId) }),
          ])
          return result
        },
        onError(error, file) {
          // The docs storage of the plan: the plan limit flow, not a toast.
          if (reportBillingDenial(error)) return
          toast.error(`Could not add ${file.name || "the image"}`, {
            description: getDocsBranchErrorMessage(error, "The upload failed. Try again."),
          })
        },
      },
    }),
    [branch, projectId, queryClient],
  )
  return <EditorAssetsContext.Provider value={value}>{children}</EditorAssetsContext.Provider>
}

/** The image uploader of the open page, or null outside the content editor. */
export function useImageUploader(): ImageUploader | null {
  return useContext(EditorAssetsContext)?.uploader ?? null
}

/**
 * The URL to draw an image source with. An `/assets/…` path loads through the
 * branch, because the docs host serves only published images. Any other
 * source is used as it is.
 */
export function useImageSource(src: string): { url: string | null; failed: boolean } {
  const assets = useContext(EditorAssetsContext)
  const isAsset = Boolean(assets && docsAssetNameFromUrlPath(src))
  const query = useQuery({
    ...branchAssetQueryOptions(assets?.projectId ?? "", assets?.branch ?? "main", src),
    enabled: isAsset,
  })
  if (!isAsset) return { url: src || null, failed: false }
  return { url: query.data ?? null, failed: query.isError }
}
