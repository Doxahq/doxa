import { queryOptions } from "@tanstack/react-query"

import { getDoxabotInstructions } from "~/lib/doxabot-instructions-api"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"

/** Under the project key, so a project-wide invalidation refreshes it too. */
export const doxabotInstructionsQueryKey = (projectId: string) =>
  [...dashboardQueryKeys.project(projectId), "doxabot-instructions"] as const

/** Instructions change only from the editor, so they stay fresh for a while. */
export function doxabotInstructionsQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: doxabotInstructionsQueryKey(projectId),
    queryFn: () => getDoxabotInstructions(projectId),
    staleTime: 60_000,
  })
}
