import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { BranchRef } from "@doxahq/contracts/docs-branches"

import { ApiRequestError } from "~/lib/api-errors"
import {
  docsBranchQueryKeys,
  docsBranchStatusQueryOptions,
} from "~/lib/queries/docs-branches"

export function useBranchStatus(
  projectId: string,
  branch: BranchRef,
  enabled = true,
) {
  return useQuery({
    ...docsBranchStatusQueryOptions(projectId, branch),
    enabled,
    refetchInterval: () => typeof document !== "undefined" && document.visibilityState === "visible"
      ? 30_000
      : false,
    refetchOnWindowFocus: true,
  })
}

export function useRefreshBranchStatus(projectId: string, branch: BranchRef) {
  const queryClient = useQueryClient()

  return (error: unknown): void => {
    if (!(error instanceof ApiRequestError)) return
    if (error.status !== 409 || (error.code !== "branch_behind" && error.code !== "main_changed")) {
      return
    }
    void queryClient.invalidateQueries({
      queryKey: docsBranchQueryKeys.status(projectId, branch),
    })
  }
}
