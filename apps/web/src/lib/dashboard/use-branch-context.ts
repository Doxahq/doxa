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

const CONTENT_EDITOR_PATH = /^\/dashboard\/projects\/[^/]+\/content(?:\/|$)/
const SITE_SETTINGS_PATH = /^\/dashboard\/projects\/[^/]+\/site(?:\/|$)/

/**
 * True when a page change opens site settings on `main`. Only the content
 * editor shows and switches the branch, so site settings keep the selected
 * branch only when the user comes from the editor. From any other page, and
 * on a page load, they open on `main`.
 */
export function opensSiteSettingsOnMain(previousPathname: string | null, pathname: string): boolean {
  if (!SITE_SETTINGS_PATH.test(pathname)) return false
  if (previousPathname === null) return true
  return !SITE_SETTINGS_PATH.test(previousPathname) && !CONTENT_EDITOR_PATH.test(previousPathname)
}

/**
 * The branch selection of a project. `pathname` is the page on screen: when
 * it opens site settings from outside the content editor, the selection
 * becomes `main` (see `opensSiteSettingsOnMain`).
 */
export function useBranchContext(projectId: string, pathname: string | null = null) {
  const branchQuery = useQuery(docsBranchListQueryOptions(projectId))
  const branches = useMemo(
    () => [...(branchQuery.data?.branches ?? [])]
      .filter((branch): branch is NamedDocsBranch => branch.kind === "named")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [branchQuery.data?.branches],
  )
  const [storedRef, setStoredRef] = useState<BranchRef>(() => readStoredBranch(projectId))
  const [lastPathname, setLastPathname] = useState<string | null>(null)
  // Set during render, so site settings never load the old branch first.
  let selectedRef = storedRef
  if (pathname !== null && pathname !== lastPathname) {
    setLastPathname(pathname)
    if (storedRef !== "main" && opensSiteSettingsOnMain(lastPathname, pathname)) {
      setStoredRef("main")
      selectedRef = "main"
    }
  }
  const branchRef = branchQuery.data
    ? resolveSelectedBranchRef(selectedRef, branches)
    : selectedRef

  useEffect(() => {
    if (!branchQuery.data || branchRef === storedRef) return
    setStoredRef(branchRef)
  }, [branchQuery.data, branchRef, storedRef])

  useEffect(() => {
    writeStoredBranch(projectId, storedRef)
  }, [projectId, storedRef])

  const selectBranch = useCallback((next: BranchRef) => {
    setStoredRef(next)
  }, [])

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
