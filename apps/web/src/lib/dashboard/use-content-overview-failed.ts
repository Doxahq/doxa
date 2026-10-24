import { useQuery } from "@tanstack/react-query"

import { useOptionalProjectBranch } from "~/lib/dashboard/project-branch-context"
import { projectContentQueryOptions } from "~/lib/queries/dashboard"

/**
 * True when the content overview of the open branch failed, for example for a
 * project without docs. The Content view then has no list to wait for.
 *
 * Any other state means the list is coming: the overview is loading, or it is
 * there and the editor holds the list back until the page body is ready too.
 *
 * It only watches the query. The editor fetches it, so this hook never starts
 * a request of its own.
 */
export function useContentOverviewFailed(projectId: string): boolean {
  const branch = useOptionalProjectBranch()?.branchRef ?? "main"
  return useQuery({ ...projectContentQueryOptions(projectId, branch), enabled: false }).status === "error"
}
