import { useEffect, useMemo, useReducer, useState } from "react"
import type { AgentActivitySnapshot } from "@doxahq/contracts/agent-live-activity"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { revokeProjectAgent } from "~/lib/agent-activity-api"
import { followAgentActivity, type AgentActivityConnection } from "~/lib/agent-activity-stream"
import {
  applyStreamMessage,
  msUntilPresenceChanges,
  snapshotAt,
  strongestPresence,
} from "~/lib/dashboard/agent-activity-model"
import { agentAccessQueryKeys } from "~/lib/queries/agent-access"
import { agentActivityQueryKeys, agentActivityQueryOptions } from "~/lib/queries/agent-activity"

function useTabVisible(): boolean {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible")
    update()
    document.addEventListener("visibilitychange", update)
    return () => document.removeEventListener("visibilitychange", update)
  }, [])
  return visible
}

/**
 * The snapshot as it is now. An agent stops being active when its last event
 * gets too old, even if the stream is quiet or down, or the tab was hidden.
 */
function useCurrentSnapshot(
  received: AgentActivitySnapshot | null,
  receivedAt: number,
  visible: boolean,
): AgentActivitySnapshot | null {
  const [expiries, countExpiry] = useReducer((count: number) => count + 1, 0)
  const current = useMemo(
    () => (received === null ? null : snapshotAt(received, Date.parse(received.serverTime) + Date.now() - receivedAt)),
    // `expiries` and `visible` mark that time passed without a new snapshot.
    [received, receivedAt, expiries, visible],
  )

  useEffect(() => {
    if (current === null) return
    const delay = msUntilPresenceChanges(current.agents, Date.parse(current.serverTime))
    if (delay === null) return
    const timer = setTimeout(countExpiry, delay)
    return () => clearTimeout(timer)
  }, [current])

  return current
}

/**
 * The live activity of a project. `snapshot` is null while it loads or while
 * the feature is off. The stream closes while the tab is hidden.
 */
export function useAgentActivity(projectId: string) {
  const queryClient = useQueryClient()
  const visible = useTabVisible()
  const [connection, setConnection] = useState<AgentActivityConnection>("connecting")
  const query = useQuery(agentActivityQueryOptions(projectId, { poll: connection !== "live" }))
  const snapshot = useCurrentSnapshot(query.data ?? null, query.dataUpdatedAt, visible)
  const featureOn = snapshot !== null

  useEffect(() => {
    if (!featureOn || !visible) return
    const controller = new AbortController()
    void followAgentActivity({
      projectId,
      signal: controller.signal,
      onConnection: setConnection,
      onMessage: (message) =>
        queryClient.setQueryData(agentActivityQueryKeys.project(projectId), (current: typeof snapshot | undefined) =>
          applyStreamMessage(current ?? null, message),
        ),
    }).then(() => {
      // The stream gave up for good, so polling carries the panel.
      if (!controller.signal.aborted) setConnection("reconnecting")
    })
    return () => {
      controller.abort()
      setConnection("connecting")
    }
  }, [featureOn, projectId, queryClient, visible])

  return { snapshot, connection, presence: snapshot === null ? null : strongestPresence(snapshot.agents) }
}

export function useRevokeProjectAgent(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (grantRef: string) => revokeProjectAgent(projectId, grantRef),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: agentActivityQueryKeys.project(projectId) }),
        queryClient.invalidateQueries({ queryKey: agentAccessQueryKeys.grants() }),
      ])
    },
  })
}
