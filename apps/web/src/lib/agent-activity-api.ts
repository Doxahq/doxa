import {
  agentActivityDiffSchema,
  agentActivitySnapshotSchema,
  type AgentActivitySnapshot,
} from "@doxahq/contracts/agent-live-activity"

import { ApiRequestError } from "~/lib/api-errors"
import { apiFetch } from "~/lib/platform-api"

function activityPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/agent-activity`
}

/** Null while the feature is off, so that the editor shows no Agent button. */
export async function getAgentActivity(projectId: string): Promise<AgentActivitySnapshot | null> {
  try {
    return agentActivitySnapshotSchema.parse(await apiFetch<unknown>(activityPath(projectId)))
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.status === 404) return null
    throw cause
  }
}

export async function getAgentActivityDiff(projectId: string, seq: number): Promise<string> {
  const payload = await apiFetch<unknown>(`${activityPath(projectId)}/${seq}/diff`)
  return agentActivityDiffSchema.parse(payload).diff
}

export async function revokeProjectAgent(projectId: string, grantRef: string): Promise<void> {
  await apiFetch<unknown>(`${activityPath(projectId)}/agents/${encodeURIComponent(grantRef)}`, {
    method: "DELETE",
  })
}
