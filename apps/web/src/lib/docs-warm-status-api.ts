import {
  docsWarmStatusResponseSchema,
  type DocsWarmStatusResponse,
} from "@doxahq/contracts/docs-warm-job"

import { apiFetch } from "~/lib/platform-api"

/** `GET /projects/:projectId/warm-status` (M45b). */
export type DocsWarmStatusResult = DocsWarmStatusResponse

const UNKNOWN: DocsWarmStatusResult = { status: null, clientRegion: null }

/** An answer outside the contract reads as "unknown", so the UI shows nothing. */
export async function getDocsWarmStatus(projectId: string): Promise<DocsWarmStatusResult> {
  const payload = await apiFetch<unknown>(`/projects/${encodeURIComponent(projectId)}/warm-status`)
  const parsed = docsWarmStatusResponseSchema.safeParse(payload)
  return parsed.success ? parsed.data : UNKNOWN
}
