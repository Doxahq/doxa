import {
  approvalRequestLinkSchema,
  approvalRequestListSchema,
  approveApprovalRequestEventSchema,
  dashboardApprovalRequestSchema,
  type ApprovalRequestLink,
  type ApprovalRequestList,
  type ApprovalRequestStatus,
  type ApproveApprovalRequestEvent,
  type ApproveApprovalRequestInput,
  type DashboardApprovalRequest,
} from "@doxahq/contracts/approval-requests"
import type { DocsPublishStage } from "@doxahq/contracts/docs-branches"

import { createApiError } from "~/lib/api-errors"
import { createSseParser } from "~/lib/generation-stream"
import { apiFetch, getApiRequestHeaders, getApiUrl } from "~/lib/platform-api"

function requestPath(projectId: string, requestId?: string, action?: "approve" | "reject"): string {
  const base = `/projects/${encodeURIComponent(projectId)}/approval-requests`
  if (!requestId) return base
  const item = `${base}/${encodeURIComponent(requestId)}`
  return action ? `${item}/${action}` : item
}

/** The target of the web link `/approve/<id>`. Fails with status 404 for anyone but the owner. */
export async function getApprovalRequestLink(requestId: string): Promise<ApprovalRequestLink> {
  const payload = await apiFetch<unknown>(`/approval-requests/${encodeURIComponent(requestId)}`)
  return approvalRequestLinkSchema.parse(payload)
}

export async function listApprovalRequests(
  projectId: string,
  status?: ApprovalRequestStatus,
): Promise<ApprovalRequestList> {
  const query = status ? `?status=${encodeURIComponent(status)}` : ""
  const payload = await apiFetch<unknown>(`${requestPath(projectId)}${query}`)
  return approvalRequestListSchema.parse(payload)
}

export async function getApprovalRequest(projectId: string, requestId: string): Promise<DashboardApprovalRequest> {
  const payload = await apiFetch<unknown>(requestPath(projectId, requestId))
  return dashboardApprovalRequestSchema.parse(payload)
}

export async function rejectApprovalRequest(
  projectId: string,
  requestId: string,
  reason: string,
): Promise<DashboardApprovalRequest> {
  const payload = await apiFetch<unknown>(requestPath(projectId, requestId, "reject"), {
    method: "POST",
    json: reason.trim().length > 0 ? { reason: reason.trim() } : {},
  })
  return dashboardApprovalRequestSchema.parse(payload)
}

/**
 * Approves and runs the action. A publish streams its stages; every other
 * action answers with one `result` event.
 */
export async function approveApprovalRequest(
  projectId: string,
  requestId: string,
  input: ApproveApprovalRequestInput,
  onStage: (stage: DocsPublishStage) => void,
): Promise<DashboardApprovalRequest> {
  const response = await fetch(getApiUrl(requestPath(projectId, requestId, "approve")), {
    method: "POST",
    credentials: "include",
    headers: getApiRequestHeaders({ accept: "text/event-stream", "content-type": "application/json" }),
    body: JSON.stringify(input),
  })
  if (!response.ok) throw createApiError(response.status, await response.json().catch(() => null))
  if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
    return dashboardApprovalRequestSchema.parse(await response.json())
  }
  const outcome = await readOutcome(response.body, onStage)
  if (outcome?.type === "result") return outcome.result
  if (outcome?.type === "error") throw createApiError(outcome.status, outcome.body)
  throw new Error("The connection closed before the action finished. Reload the page to see the result.")
}

async function readOutcome(
  body: ReadableStream<Uint8Array>,
  onStage: (stage: DocsPublishStage) => void,
): Promise<ApproveApprovalRequestEvent | undefined> {
  const outcomes: ApproveApprovalRequestEvent[] = []
  const parser = createSseParser((frame) => {
    const event = approveApprovalRequestEventSchema.safeParse(parseEventData(frame.data))
    if (!event.success) throw new Error("The approval returned an invalid event.")
    if (event.data.type === "stage") onStage(event.data.stage)
    else outcomes.push(event.data)
  })
  const reader = body.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      parser.push(decoder.decode(chunk.value, { stream: true }))
    }
    parser.push(decoder.decode())
    parser.finish()
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  return outcomes.at(-1)
}

function parseEventData(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}
