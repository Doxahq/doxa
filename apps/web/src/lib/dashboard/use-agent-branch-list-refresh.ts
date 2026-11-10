import { useEffect, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type {
  AgentActivitySnapshot,
  AgentLiveEvent,
  AgentLiveEventKind,
} from "@doxahq/contracts/agent-live-activity"

import { docsBranchQueryKeys } from "~/lib/queries/docs-branches"

/** These add or remove a branch, or change its count of unpublished pages. */
const KINDS_THAT_CHANGE_BRANCHES: ReadonlySet<AgentLiveEventKind> = new Set(["edit", "branch", "publish"])

/** Pure: true when an event after `afterSeq` shows that the list of branches is out of date. */
export function changesBranchList(
  events: readonly AgentLiveEvent[],
  afterSeq: number,
  listedBranches: ReadonlySet<string>,
): boolean {
  return events.some(
    ({ seq, kind, branchId }) =>
      seq > afterSeq &&
      (KINDS_THAT_CHANGE_BRANCHES.has(kind) || (branchId !== null && !listedBranches.has(branchId))),
  )
}

/**
 * Keeps the list of branches in step with the agents of the project, on every
 * branch. A branch that the list does not hold cannot open: it falls back to main.
 */
export function useAgentBranchListRefresh(input: {
  projectId: string
  snapshot: AgentActivitySnapshot | null
  listedBranches: readonly { id: string }[]
}): void {
  const { projectId, snapshot, listedBranches } = input
  const queryClient = useQueryClient()
  const latest = useRef({ snapshot, listedBranches })
  latest.current = { snapshot, listedBranches }
  const seenSeq = useRef<number | null>(null)
  const latestSeq = snapshot?.latestSeq ?? null

  useEffect(() => {
    const current = latest.current
    if (current.snapshot === null || latestSeq === null) return
    const previous = seenSeq.current
    seenSeq.current = latestSeq
    // The first snapshot is history, and the list loaded with the page.
    if (previous === null || latestSeq <= previous) return
    const listed = new Set(current.listedBranches.map(({ id }) => id))
    if (!changesBranchList(current.snapshot.events, previous, listed)) return
    void queryClient.invalidateQueries({ queryKey: docsBranchQueryKeys.list(projectId) })
  }, [latestSeq, projectId, queryClient])
}
