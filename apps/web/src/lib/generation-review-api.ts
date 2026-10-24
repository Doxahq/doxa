import type {
  DecideGenerationReviewPagesInput,
  GenerationChanges,
  GenerationReview,
  GenerationReviewPageSources,
  GenerationReviewResponse,
  PublishGenerationReviewInput,
  PublishGenerationReviewResult,
} from "@doxahq/contracts/generation-reviews"

import { apiFetch } from "~/lib/platform-api"

function reviewPath(projectId: string, path = ""): string {
  return `/projects/${encodeURIComponent(projectId)}/generation-review${path}`
}

export async function getGenerationReview(projectId: string): Promise<GenerationReview | null> {
  const response = await apiFetch<GenerationReviewResponse>(reviewPath(projectId))
  return response.review
}

export async function getGenerationReviewPage(
  projectId: string,
  href: string,
): Promise<GenerationReviewPageSources> {
  return apiFetch<GenerationReviewPageSources>(
    reviewPath(projectId, `/page?href=${encodeURIComponent(href)}`),
  )
}

export async function decideGenerationReviewPages(
  projectId: string,
  input: DecideGenerationReviewPagesInput,
): Promise<GenerationReview> {
  const response = await apiFetch<{ review: GenerationReview }>(reviewPath(projectId, "/decisions"), {
    method: "POST",
    json: input,
  })
  return response.review
}

export async function publishGenerationReview(
  projectId: string,
  input: PublishGenerationReviewInput,
): Promise<PublishGenerationReviewResult> {
  return apiFetch<PublishGenerationReviewResult>(reviewPath(projectId, "/publish"), {
    method: "POST",
    json: input,
  })
}

export async function discardGenerationReview(projectId: string): Promise<void> {
  await apiFetch<unknown>(reviewPath(projectId, "/discard"), { method: "POST" })
}

function changesPath(projectId: string, generationId: string, path = ""): string {
  return `/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}/changes${path}`
}

/** The read-only changes of a pull request preview run. */
export async function getGenerationChanges(projectId: string, generationId: string): Promise<GenerationChanges> {
  const response = await apiFetch<{ changes: GenerationChanges }>(changesPath(projectId, generationId))
  return response.changes
}

export async function getGenerationChangedPage(
  projectId: string,
  generationId: string,
  href: string,
): Promise<GenerationReviewPageSources> {
  return apiFetch<GenerationReviewPageSources>(
    changesPath(projectId, generationId, `/page?href=${encodeURIComponent(href)}`),
  )
}
