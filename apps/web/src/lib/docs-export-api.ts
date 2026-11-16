import { docsExportStatusSchema, type DocsExportStatus } from "@doxahq/contracts/docs-export"

import { createApiError } from "~/lib/api-errors"
import { apiFetch, getApiRequestHeaders, getApiUrl, usesDevUserHeader } from "~/lib/platform-api"

function exportPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/export`
}

/** Whether the docs export can run now, and when the next one can. */
export async function getDocsExportStatus(projectId: string): Promise<DocsExportStatus> {
  return docsExportStatusSchema.parse(await apiFetch<unknown>(`${exportPath(projectId)}/status`))
}

/**
 * Starts the download of the docs archive. The browser follows the link and
 * saves the `attachment` response itself, so the archive never sits in the
 * memory of the page. Local dev signs in with a header that a link cannot
 * send, so there the page fetches the archive instead.
 */
export async function startDocsExportDownload(projectId: string): Promise<void> {
  const url = getApiUrl(exportPath(projectId))
  if (!usesDevUserHeader()) {
    const link = document.createElement("a")
    link.href = url
    link.rel = "noopener"
    document.body.append(link)
    link.click()
    link.remove()
    return
  }
  const response = await fetch(url, { credentials: "include", headers: getApiRequestHeaders() })
  if (!response.ok) throw createApiError(response.status, await response.json().catch(() => null))
  const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "docs-export.zip"
  const objectUrl = URL.createObjectURL(await response.blob())
  const link = document.createElement("a")
  link.href = objectUrl
  link.download = name
  link.click()
  URL.revokeObjectURL(objectUrl)
}
