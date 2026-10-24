import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type {
  BranchRef,
  DocsConflict,
  SyncDocsBranchInput,
} from "@doxahq/contracts/docs-branches"
import type { ValidationIssue } from "@doxahq/contracts/validation"

import { ApiRequestError, isApiValidationError } from "~/lib/api-errors"
import { useRefreshBranchStatus } from "~/lib/dashboard/use-branch-status"
import { getErrorMessage } from "~/lib/errors"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"
import {
  docsBranchQueryKeys,
  docsBranchSyncQueryOptions,
} from "~/lib/queries/docs-branches"
import { syncDocsBranch } from "~/lib/docs-branches-api"

type Resolution = "mine" | "main"

export function useSyncBranch(options: {
  projectId: string
  branch: BranchRef
  open: boolean
  onSuccess: () => void
}) {
  const { projectId, branch, open, onSuccess } = options
  const queryClient = useQueryClient()
  const refreshStatus = useRefreshBranchStatus(projectId, branch)
  const previewQuery = useQuery(docsBranchSyncQueryOptions(projectId, branch, open))
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({})
  const [issues, setIssues] = useState<readonly ValidationIssue[]>([])
  const [requestError, setRequestError] = useState<string | null>(null)

  const conflicts = useMemo(() => previewQuery.data?.conflicts ?? [], [previewQuery.data])

  useEffect(() => {
    if (open) return
    setResolutions({})
    setIssues([])
    setRequestError(null)
  }, [open])

  useEffect(() => {
    const activeKeys = new Set(conflicts.map(({ key }) => key))
    setResolutions((current) => Object.fromEntries(
      Object.entries(current).filter(([key]) => activeKeys.has(key)),
    ))
  }, [conflicts])

  const mutation = useMutation({
    mutationFn: (input: SyncDocsBranchInput) => syncDocsBranch(projectId, branch, input),
    onSuccess: async () => {
      setIssues([])
      setRequestError(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.content(projectId, branch) }),
        queryClient.invalidateQueries({ queryKey: docsBranchQueryKeys.list(projectId) }),
        queryClient.invalidateQueries({ queryKey: docsBranchQueryKeys.status(projectId, branch) }),
      ])
      onSuccess()
    },
    onError: async (error) => {
      refreshStatus(error)
      if (error instanceof ApiRequestError && error.status === 409 && error.code === "main_changed") {
        setRequestError("Main changed again. The synchronization plan was reloaded.")
        await previewQuery.refetch()
        return
      }
      if (isApiValidationError(error)) {
        setIssues(error.issues)
        setRequestError(null)
        return
      }
      setRequestError(getErrorMessage(error, "The branch could not be synchronized."))
    },
  })

  function setResolution(key: DocsConflict["key"], resolution: Resolution) {
    setResolutions((current) => ({ ...current, [key]: resolution }))
  }

  function setAll(resolution: Resolution) {
    setResolutions(Object.fromEntries(conflicts.map(({ key }) => [key, resolution])))
  }

  async function synchronize(): Promise<void> {
    const preview = previewQuery.data
    if (!preview) return
    setIssues([])
    setRequestError(null)
    await mutation.mutateAsync({
      expectedMainVersionId: preview.mainVersionId,
      resolutions: conflicts.flatMap(({ key }) => {
        const resolution = resolutions[key]
        return resolution ? [{ key, resolution }] : []
      }),
    }).catch(() => undefined)
  }

  return {
    preview: previewQuery.data ?? null,
    conflicts,
    resolutions,
    setResolution,
    setAll,
    synchronize,
    issues,
    error: requestError
      ?? (previewQuery.error
        ? getErrorMessage(previewQuery.error, "The synchronization plan could not be loaded.")
        : null),
    isLoading: previewQuery.isPending,
    isSynchronizing: mutation.isPending,
    canSynchronize: Boolean(
      previewQuery.data
      && conflicts.every(({ key }) => resolutions[key] !== undefined),
    ),
  }
}
