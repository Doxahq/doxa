import { useMutation, useQueryClient } from "@tanstack/react-query"

import { isApiValidationError } from "~/lib/api-errors"
import { eraseDocsBranch, renameDocsBranch } from "~/lib/docs-branches-api"
import { getErrorMessage } from "~/lib/errors"
import { docsBranchQueryKeys } from "~/lib/queries/docs-branches"

/**
 * Renaming and erasing a named branch. Both refresh the branch list, so the
 * switcher shows the result as soon as the request succeeds.
 */
export function useBranchActions(projectId: string) {
  const queryClient = useQueryClient()
  const refreshBranches = () => queryClient.invalidateQueries({ queryKey: docsBranchQueryKeys.list(projectId) })

  const rename = useMutation({
    mutationFn: ({ branchId, name }: { branchId: string; name: string }) => renameDocsBranch(projectId, branchId, { name }),
    onSuccess: refreshBranches,
  })

  const erase = useMutation({
    mutationFn: (branchId: string) => eraseDocsBranch(projectId, branchId),
    onSuccess: refreshBranches,
  })

  return { rename, erase }
}

/** The message for a failed rename: the name rule it broke, or the request error. */
export function renameErrorMessage(error: unknown): string {
  return isApiValidationError(error)
    ? (error.issues[0]?.message ?? "The branch name is not valid.")
    : getErrorMessage(error, "The branch could not be renamed.")
}

export function eraseErrorMessage(error: unknown): string {
  return getErrorMessage(error, "The branch could not be erased.")
}
