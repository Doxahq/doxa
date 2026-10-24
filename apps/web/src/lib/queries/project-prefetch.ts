import type { QueryClient } from "@tanstack/react-query"

import { readStoredBranch } from "~/lib/dashboard/use-branch-context"
import { approvalRequestListQueryOptions } from "~/lib/queries/approval-requests"
import {
  pendingMergesQueryOptions,
  projectContentPageQueryOptions,
  projectContentQueryOptions,
  projectDetailQueryOptions,
  projectDoxabotQueryOptions,
  projectGenerationCacheQueryOptions,
  projectGenerationsQueryOptions,
} from "~/lib/queries/dashboard"
import { docsBranchListQueryOptions } from "~/lib/queries/docs-branches"
import { generationReviewQueryOptions } from "~/lib/queries/generation-review"

/** The project routes whose loaders start requests. */
export type ProjectPrefetchPage = "workspace" | "overview" | "content" | "generations" | "requests" | "settings"

export interface ProjectPrefetchInput {
  projectId: string
  /** The content page from the URL (`?page=`), if any. */
  contentPageHref?: string | null
}

/**
 * Starts the requests that a project page sends when it mounts, with the same
 * query options, so the page finds them in flight or done.
 *
 * A query that already has data is left alone: the page decides whether to
 * refetch it, as before. So a loader that runs again (a hover, a search
 * change, a child page) sends no extra request.
 *
 * The project layout's and the Overview's queries load through one project
 * shell request (see `lib/queries/project-shell.ts`), so the layout and the
 * Overview together send one request, not one per query.
 */
export function prefetchProjectPage(
  queryClient: QueryClient,
  page: ProjectPrefetchPage,
  input: ProjectPrefetchInput,
): Promise<PromiseSettledResult<unknown>[]> {
  return Promise.allSettled(projectPageRequests(queryClient, page, input))
}

function projectPageRequests(
  queryClient: QueryClient,
  page: ProjectPrefetchPage,
  { projectId, contentPageHref = null }: ProjectPrefetchInput,
): Promise<unknown>[] {
  switch (page) {
    // The project layout: the sidebar, the top bar and the branch selection.
    case "workspace":
      return [
        queryClient.ensureQueryData(projectDetailQueryOptions(projectId)),
        queryClient.ensureQueryData(docsBranchListQueryOptions(projectId)),
      ]
    case "overview":
      return [
        queryClient.ensureQueryData(generationReviewQueryOptions(projectId)),
        queryClient.ensureQueryData(pendingMergesQueryOptions(projectId)),
        queryClient.ensureQueryData(projectDoxabotQueryOptions(projectId)),
        queryClient.ensureInfiniteQueryData(projectGenerationsQueryOptions(projectId)),
      ]
    case "content": {
      // The editor starts on the branch this browser chose last, before the
      // branch list confirms it, so the keys match the editor's first ones.
      const branch = readStoredBranch(projectId)
      return [
        queryClient.ensureQueryData(projectContentQueryOptions(projectId, branch)),
        ...(contentPageHref
          ? [queryClient.ensureQueryData(projectContentPageQueryOptions(projectId, branch, contentPageHref))]
          : []),
      ]
    }
    case "generations":
      return [
        queryClient.ensureInfiniteQueryData(projectGenerationsQueryOptions(projectId)),
        queryClient.ensureQueryData(generationReviewQueryOptions(projectId)),
      ]
    case "requests":
      // The page opens on the "all" filter.
      return [queryClient.ensureQueryData(approvalRequestListQueryOptions(projectId))]
    case "settings":
      return [
        queryClient.ensureQueryData(projectGenerationCacheQueryOptions(projectId)),
        queryClient.ensureQueryData(projectDoxabotQueryOptions(projectId)),
      ]
  }
}
