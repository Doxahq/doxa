import { useCallback, useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  branchRefSchema,
  type BranchRef,
  type NamedDocsBranch,
} from "@doxahq/contracts/docs-branches"

import { docsBranchListQueryOptions } from "~/lib/queries/docs-branches"

const STORAGE_PREFIX = "doxa:docs-branch:"

export function resolveSelectedBranchRef(
  stored: string | null,
  branches: readonly NamedDocsBranch[],
): BranchRef {
  if (!stored || stored === "main") return "main"
  return branches.some(({ id }) => id === stored) ? stored : "main"
}

export function useBranchContext(projectId: string) {
  const branchQuery = useQuery(docsBranchListQueryOptions(projectId))
  const branches = useMemo(
    () => [...(branchQuery.data?.branches ?? [])]
      .filter((branch): branch is NamedDocsBranch => branch.kind === "named")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [branchQuery.data?.branches],
  )
  const [storedRef, setStoredRef] = useState<BranchRef>(() => readStoredBranch(projectId))
  const branchRef = branchQuery.data
    ? resolveSelectedBranchRef(storedRef, branches)
    : storedRef === "main"
      ? "main"
      : storedRef

  useEffect(() => {
    if (!branchQuery.data || branchRef === storedRef) return
    setStoredRef(branchRef)
    writeStoredBranch(projectId, branchRef)
  }, [branchQuery.data, branchRef, projectId, storedRef])

  const selectBranch = useCallback((next: BranchRef) => {
    setStoredRef(next)
    writeStoredBranch(projectId, next)
  }, [projectId])

  const selectedBranch = branches.find(({ id }) => id === branchRef) ?? null

  return {
    branchRef,
    selectedBranch,
    branches,
    maxBranchesPerSite: branchQuery.data?.maxBranchesPerSite ?? null,
    selectBranch,
    isLoading: branchQuery.isPending,
    error: branchQuery.error,
  }
}

/** The branch this browser last chose for the project, or "main". */
export function readStoredBranch(projectId: string): BranchRef {
  try {
    const parsed = branchRefSchema.safeParse(localStorage.getItem(`${STORAGE_PREFIX}${projectId}`))
    return parsed.success ? parsed.data : "main"
  } catch {
    return "main"
  }
}

function writeStoredBranch(projectId: string, branch: BranchRef): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${projectId}`, branch)
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}
