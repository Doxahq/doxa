import type {
  BranchRef,
  CreateDocsBranchInput,
  DocsBranch,
  DocsBranchList,
  DocsBranchDiff,
  DocsBranchPageSources,
  DocsBranchPreviewResult,
  DocsBranchStatus,
  DocsConflict,
  DocsConflictDiff,
  DocsPublicationPage,
  DocsPublishStage,
  DocsSyncPreview,
  PublishDocsBranchEvent,
  PublishDocsBranchInput,
  PublishDocsBranchResult,
  RenameDocsBranchInput,
  SyncDocsBranchInput,
} from "@doxahq/contracts/docs-branches"
import { publishDocsBranchEventSchema } from "@doxahq/contracts/docs-branches"

import { createApiError } from "~/lib/api-errors"
import { createSseParser } from "~/lib/generation-stream"
import { apiFetch, getApiRequestHeaders, getApiUrl } from "~/lib/platform-api"

export async function listDocsBranches(projectId: string): Promise<DocsBranchList> {
  return apiFetch<DocsBranchList>(`/projects/${encodeURIComponent(projectId)}/branches`)
}

export async function createDocsBranch(
  projectId: string,
  input: CreateDocsBranchInput,
): Promise<DocsBranch> {
  return apiFetch<DocsBranch>(`/projects/${encodeURIComponent(projectId)}/branches`, {
    method: "POST",
    json: input,
  })
}

export async function renameDocsBranch(
  projectId: string,
  branchId: string,
  input: RenameDocsBranchInput,
): Promise<DocsBranch> {
  return apiFetch<DocsBranch>(
    `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}`,
    { method: "PATCH", json: input },
  )
}

export async function eraseDocsBranch(projectId: string, branchId: string): Promise<void> {
  await apiFetch<unknown>(
    `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}`,
    { method: "DELETE" },
  )
}

export async function getDocsBranchStatus(
  projectId: string,
  branch: BranchRef,
): Promise<DocsBranchStatus> {
  return apiFetch<DocsBranchStatus>(docsBranchPath(projectId, branch, "status"))
}

export async function getDocsBranchSyncPreview(
  projectId: string,
  branch: BranchRef,
): Promise<DocsSyncPreview> {
  return apiFetch<DocsSyncPreview>(docsBranchPath(projectId, branch, "sync"))
}

export async function getDocsBranchConflictDiff(
  projectId: string,
  branch: BranchRef,
  key: DocsConflict["key"],
): Promise<DocsConflictDiff> {
  const searchParams = new URLSearchParams({ key })
  return apiFetch<DocsConflictDiff>(
    `${docsBranchPath(projectId, branch, "sync/diff")}?${searchParams.toString()}`,
  )
}

/** What a publish of the branch changes, against the branch base. */
export async function getDocsBranchDiff(projectId: string, branch: BranchRef): Promise<DocsBranchDiff> {
  return apiFetch<DocsBranchDiff>(docsBranchPath(projectId, branch, "diff"))
}

/** Both full sources of one changed page, for the side-by-side diff. */
export async function getDocsBranchPageSources(
  projectId: string,
  branch: BranchRef,
  href: string,
): Promise<DocsBranchPageSources> {
  const searchParams = new URLSearchParams({ href })
  return apiFetch<DocsBranchPageSources>(
    `${docsBranchPath(projectId, branch, "diff/page")}?${searchParams.toString()}`,
  )
}

export async function syncDocsBranch(
  projectId: string,
  branch: BranchRef,
  input: SyncDocsBranchInput,
): Promise<{ revision: number; changeCount: number }> {
  return apiFetch(docsBranchPath(projectId, branch, "sync"), {
    method: "POST",
    json: input,
  })
}

export async function publishDocsBranch(
  projectId: string,
  branch: BranchRef,
  input: PublishDocsBranchInput,
): Promise<PublishDocsBranchResult> {
  return apiFetch<PublishDocsBranchResult>(docsBranchPath(projectId, branch, "publish"), {
    method: "POST",
    json: input,
  })
}

/**
 * Publishes like `publishDocsBranch`, and calls `onStage` when the server
 * reaches each stage. The result and the errors are the same.
 */
export async function publishDocsBranchWithProgress(
  projectId: string,
  branch: BranchRef,
  input: PublishDocsBranchInput,
  onStage: (stage: DocsPublishStage) => void,
): Promise<PublishDocsBranchResult> {
  const response = await fetch(getApiUrl(docsBranchPath(projectId, branch, "publish")), {
    method: "POST",
    credentials: "include",
    headers: getApiRequestHeaders({
      accept: "text/event-stream",
      "content-type": "application/json",
    }),
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw createApiError(response.status, await response.json().catch(() => null))
  }

  // An API without the stream answers with the plain JSON result.
  if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
    return (await response.json()) as PublishDocsBranchResult
  }

  const outcomes: PublishDocsBranchEvent[] = []
  const parser = createSseParser((frame) => {
    const event = publishDocsBranchEventSchema.safeParse(parseEventData(frame.data))
    if (!event.success) throw new Error("The publish returned an invalid event.")
    if (event.data.type === "stage") onStage(event.data.stage)
    else outcomes.push(event.data)
  })
  const reader = response.body.getReader()
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

  const outcome = outcomes.at(-1)
  if (outcome?.type === "result") return outcome.result
  if (outcome?.type === "error") throw createApiError(outcome.status, outcome.body)
  throw new Error("The connection closed before the publish finished. Reload the page to see the result.")
}

function parseEventData(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

export async function buildDocsBranchPreview(
  projectId: string,
  branch: BranchRef,
): Promise<DocsBranchPreviewResult> {
  return apiFetch<DocsBranchPreviewResult>(docsBranchPath(projectId, branch, "preview"), {
    method: "POST",
  })
}

export async function listDocsPublications(
  projectId: string,
  input: { cursor: string | null; limit: number },
): Promise<DocsPublicationPage> {
  const searchParams = new URLSearchParams({ limit: String(input.limit) })
  if (input.cursor) searchParams.set("cursor", input.cursor)
  return apiFetch<DocsPublicationPage>(
    `/projects/${encodeURIComponent(projectId)}/history?${searchParams.toString()}`,
  )
}

export async function restoreDocsPublication(
  projectId: string,
  publicationId: string,
  expectedMainVersionId: string,
): Promise<{ publicationId: string; versionId: string }> {
  return apiFetch(
    `/projects/${encodeURIComponent(projectId)}/history/${encodeURIComponent(publicationId)}/restore`,
    { method: "POST", json: { expectedMainVersionId } },
  )
}

function docsBranchPath(projectId: string, branch: BranchRef, action: string): string {
  return `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branch)}/${action}`
}
