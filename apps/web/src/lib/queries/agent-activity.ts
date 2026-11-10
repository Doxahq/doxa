import { queryOptions } from "@tanstack/react-query"

import { getAgentActivity, getAgentActivityDiff } from "~/lib/agent-activity-api"

const POLL_INTERVAL_MS = 5_000

function isTabVisible(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible"
}

export const agentActivityQueryKeys = {
  project: (projectId: string) => ["agent-activity", projectId] as const,
  diff: (projectId: string, seq: number) => ["agent-activity", projectId, "diff", seq] as const,
}

/**
 * The stream fills this cache while it is open. Polling is the fallback for
 * the time before it connects and while it is down. A null result means that
 * the feature is off.
 */
export function agentActivityQueryOptions(projectId: string, options: { poll: boolean } = { poll: true }) {
  return queryOptions({
    queryKey: agentActivityQueryKeys.project(projectId),
    queryFn: () => getAgentActivity(projectId),
    refetchInterval: (query) =>
      options.poll && query.state.data !== null && isTabVisible() ? POLL_INTERVAL_MS : false,
    refetchOnWindowFocus: options.poll,
    retry: 1,
  })
}

/** The diff of one saved edit never changes. */
export function agentActivityDiffQueryOptions(projectId: string, seq: number) {
  return queryOptions({
    queryKey: agentActivityQueryKeys.diff(projectId, seq),
    queryFn: () => getAgentActivityDiff(projectId, seq),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  })
}
