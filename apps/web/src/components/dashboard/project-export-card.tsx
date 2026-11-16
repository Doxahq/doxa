import { useEffect, useRef, useState } from "react"
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query"
import { Download, FileArchive, Loader2 } from "lucide-react"
import { toast } from "sonner"
import type { DocsExportStatus } from "@doxahq/contracts/docs-export"

import { Button } from "~/components/ui/button"
import { Card, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { exportBlockedText, exportQuotaText, exportRedirectErrorText, waitForExportClaim } from "~/lib/dashboard/docs-export"
import { startDocsExportDownload } from "~/lib/docs-export-api"
import { getErrorMessage } from "~/lib/errors"
import { docsExportStatusQueryOptions } from "~/lib/queries/docs-export"

interface ProjectExportCardProps {
  projectId: string
  status: UseQueryResult<DocsExportStatus>
}

/**
 * "Export docs": one .zip of the published pages, images and settings. The
 * card reads the export status again before each download, so the quota and
 * the published version are current. The button stays off, with a spinner,
 * from the click until the API shows the spent quota.
 */
export function ProjectExportCard({ projectId, status }: ProjectExportCardProps) {
  const queryClient = useQueryClient()
  const [starting, setStarting] = useState(false)
  // A ref, not only state: two fast clicks run before React renders again.
  const busy = useRef(false)
  const current = status.data ?? null
  const blocked = current ? exportBlockedText(current) : null
  const quota = current ? exportQuotaText(current) : null

  // A failed download link comes back here with `?export_error=<code>`.
  useEffect(() => {
    const url = new URL(window.location.href)
    const message = exportRedirectErrorText(url.searchParams.get("export_error"))
    if (!message) return
    toast.error(message)
    url.searchParams.delete("export_error")
    window.history.replaceState(window.history.state, "", url)
  }, [])

  async function exportDocs(): Promise<void> {
    if (busy.current) return
    busy.current = true
    setStarting(true)
    const options = docsExportStatusQueryOptions(projectId)
    try {
      const fresh = await queryClient.fetchQuery(options)
      const reason = exportBlockedText(fresh)
      if (reason) {
        toast.error(reason)
        return
      }
      await startDocsExportDownload(projectId)
      toast.success("Your export is downloading")
      // The download spends the quota: keep the button off until the status shows it.
      await waitForExportClaim(() => queryClient.fetchQuery(options))
    } catch (cause) {
      toast.error(getErrorMessage(cause, "The export did not start. Try again."))
      void queryClient.invalidateQueries({ queryKey: options.queryKey })
    } finally {
      busy.current = false
      setStarting(false)
    }
  }

  const disabled = starting || !current || !current.available

  return (
    <Card>
      <CardHeader className="gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <FileArchive aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-col gap-1.5">
            <CardTitle>
              <h3>Export docs</h3>
            </CardTitle>
            <CardDescription>
              Download every published page, image and setting as one .zip file. Use it to self-host
              Doxa or to keep a copy.
            </CardDescription>
            {status.isError ? (
              <p className="text-sm text-muted-foreground">Export status is not available. Try again later.</p>
            ) : blocked || quota ? (
              <p className="text-sm text-muted-foreground">{blocked ?? quota}</p>
            ) : null}
          </div>
        </div>
        <Button variant="outline" className="w-fit shrink-0" disabled={disabled} onClick={() => void exportDocs()}>
          {starting ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Download aria-hidden="true" />}
          Export docs
        </Button>
      </CardHeader>
    </Card>
  )
}
