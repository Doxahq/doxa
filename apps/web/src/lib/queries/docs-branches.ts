import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query"
import type { BranchRef, DocsConflict } from "@doxahq/contracts/docs-branches"

import {
  getDocsBranchConflictDiff,
  getDocsBranchDiff,
  getDocsBranchPageSources,
  getDocsBranchStatus,
  getDocsBranchSyncPreview,
  listDocsBranches,
  listDocsPublications,
} from "~/lib/docs-branches-api"
import { fromProjectShell } from "~/lib/queries/project-shell"

const ROOT_KEY = ["docs-branches"] as const

export const docsBranchQueryKeys = {
  all: ROOT_KEY,
  project: (projectId: string) => [...ROOT_KEY, projectId] as const,
  list: (projectId: string) => [...docsBranchQueryKeys.project(projectId), "list"] as const,
  statusRoot: (projectId: string) => [...docsBranchQueryKeys.project(projectId), "status"] as const,
  status: (projectId: string, branch: BranchRef) => [
    ...docsBranchQueryKeys.statusRoot(projectId),
    branch,
  ] as const,
  sync: (projectId: string, branch: BranchRef) => [
    ...docsBranchQueryKeys.project(projectId),
    "sync",
    branch,
  ] as const,
  diff: (projectId: string, branch: BranchRef, key: DocsConflict["key"]) => [
    ...docsBranchQueryKeys.sync(projectId, branch),
    "diff",
    key,
  ] as const,
  history: (projectId: string) => [...docsBranchQueryKeys.project(projectId), "history"] as const,
  changes: (projectId: string, branch: BranchRef) => [
    ...docsBranchQueryKeys.project(projectId),
    "changes",
    branch,
  ] as const,
  pageSources: (projectId: string, branch: BranchRef, href: string) => [
    ...docsBranchQueryKeys.changes(projectId, branch),
    "page",
    href,
  ] as const,
}

export function docsBranchListQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: docsBranchQueryKeys.list(projectId),
    queryFn: (context) => fromProjectShell(context, projectId, "branches", () => listDocsBranches(projectId)),
    staleTime: 5_000,
    retry: false,
  })
}

export function docsBranchStatusQueryOptions(projectId: string, branch: BranchRef) {
  return queryOptions({
    queryKey: docsBranchQueryKeys.status(projectId, branch),
    queryFn: () => getDocsBranchStatus(projectId, branch),
    retry: false,
  })
}

export function docsBranchSyncQueryOptions(
  projectId: string,
  branch: BranchRef,
  enabled: boolean,
) {
  return queryOptions({
    queryKey: docsBranchQueryKeys.sync(projectId, branch),
    queryFn: () => getDocsBranchSyncPreview(projectId, branch),
    enabled,
    retry: false,
  })
}

export function docsConflictDiffQueryOptions(
  projectId: string,
  branch: BranchRef,
  key: DocsConflict["key"],
) {
  return queryOptions({
    queryKey: docsBranchQueryKeys.diff(projectId, branch, key),
    queryFn: () => getDocsBranchConflictDiff(projectId, branch, key),
    staleTime: 30_000,
    retry: false,
  })
}

/** The branch diff: changed pages, structure and site settings. */
export function docsBranchDiffQueryOptions(projectId: string, branch: BranchRef) {
  return queryOptions({
    queryKey: docsBranchQueryKeys.changes(projectId, branch),
    queryFn: () => getDocsBranchDiff(projectId, branch),
    staleTime: 5_000,
    retry: false,
  })
}

/** Both sources of one changed page. */
export function docsBranchPageSourcesQueryOptions(projectId: string, branch: BranchRef, href: string) {
  return queryOptions({
    queryKey: docsBranchQueryKeys.pageSources(projectId, branch, href),
    queryFn: () => getDocsBranchPageSources(projectId, branch, href),
    staleTime: 5_000,
    retry: false,
  })
}

export function docsPublicationHistoryQueryOptions(projectId: string) {
  return infiniteQueryOptions({
    queryKey: docsBranchQueryKeys.history(projectId),
    queryFn: ({ pageParam }) => listDocsPublications(projectId, {
      cursor: pageParam,
      limit: 25,
    }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 5_000,
    retry: false,
  })
}
