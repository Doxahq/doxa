import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { BranchRef, DocsBranchStatus } from "@doxahq/contracts/docs-branches"
import { toast } from "sonner"

import { ApiRequestError } from "~/lib/api-errors"
import { buildDocsBranchPreview } from "~/lib/docs-branches-api"
import { getErrorMessage } from "~/lib/errors"
import { getDocsHostnameUrl } from "~/lib/platform-api"
import { docsBranchQueryKeys } from "~/lib/queries/docs-branches"

/**
 * The hosted preview of a branch: its URL, whether it is out of date, and the
 * build action. Building saves the editor buffer first. The publish menu shows
 * the URL when the build ends, because a browser blocks a tab that opens late.
 */
export function useBranchPreview(props: {
  projectId: string
  branch: BranchRef
  status: DocsBranchStatus | null
  saveBuffer: () => Promise<boolean>
}) {
  const queryClient = useQueryClient()
  const [url, setUrl] = useState<string | null>(() => previewUrl(props.status))
  const [error, setError] = useState<string | null>(null)
  const isOutdated = props.status?.preview?.upToDate === false
  const canBuild = props.status !== null && !(props.status.branch.kind === "hidden" && props.status.branch.id === null)

  useEffect(() => {
    setUrl(previewUrl(props.status))
    setError(null)
  }, [props.branch, props.status])

  const mutation = useMutation({
    mutationFn: () => buildDocsBranchPreview(props.projectId, props.branch),
    onSuccess: (result) => {
      setUrl(result.url)
      setError(null)
      void queryClient.invalidateQueries({
        queryKey: docsBranchQueryKeys.status(props.projectId, props.branch),
      })
    },
    onError: (cause) => {
      const message = cause instanceof ApiRequestError && cause.status === 429
        ? "Wait a few seconds, then build the preview again."
        : getErrorMessage(cause, "The preview could not be built.")
      setError(message)
      toast.error(message)
    },
  })

  // The buffer save is part of the build, so the progress starts at the click.
  const [isRunning, setIsRunning] = useState(false)

  async function build() {
    setError(null)
    setIsRunning(true)
    try {
      if (!(await props.saveBuffer())) return
      await mutation.mutateAsync().catch(() => undefined)
    } finally {
      setIsRunning(false)
    }
  }

  const isBuilding = isRunning || mutation.isPending
  // The status reloads after a build, so a new build counts as current at once.
  const isReady = url !== null && !isBuilding && !error && (mutation.isSuccess || !isOutdated)

  return {
    url,
    error,
    isOutdated,
    isReady,
    canBuild,
    isBuilding,
    build,
    /** Forgets the last build result, so the next look starts from the status. */
    reset: () => {
      mutation.reset()
      setError(null)
    },
  }
}

function previewUrl(status: DocsBranchStatus | null): string | null {
  return status?.preview ? getDocsHostnameUrl(status.preview.hostname) : null
}
