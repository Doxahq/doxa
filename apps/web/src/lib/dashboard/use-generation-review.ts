import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type {
  GenerationReview,
  GenerationReviewDecisionInput,
  PublishGenerationReviewResult,
} from "@doxahq/contracts/generation-reviews"

import {
  decideGenerationReviewPages,
  discardGenerationReview,
  publishGenerationReview,
} from "~/lib/generation-review-api"
import { ApiRequestError } from "~/lib/api-errors"
import { getErrorMessage } from "~/lib/errors"
import { docsBranchQueryKeys } from "~/lib/queries/docs-branches"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"
import {
  generationReviewQueryKeys,
  generationReviewQueryOptions,
} from "~/lib/queries/generation-review"

/** The decision of one page: a decision, or `undecided` to take one back. */
export interface ReviewPageDecisionInput {
  href: string
  decision: GenerationReviewDecisionInput
}

/** Decisions that save together, in one request. */
export interface ReviewDecisionInput {
  decisions: readonly ReviewPageDecisionInput[]
  /** True removes the pages that a person edited on the review branch, edits included. */
  discardEdits?: boolean
}

const NO_HREFS: readonly string[] = []

/**
 * How a decision ended: saved, refused because it would remove a page that a
 * person edited, so the person confirms first, or failed.
 */
export type ReviewDecisionResult = "saved" | "edits_at_risk" | "failed"

function isEditsAtRisk(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === "page_edited"
}

/**
 * The open generation review of a project and its actions. A decision
 * returns the updated review, so the cache takes it without a refetch.
 */
export function useGenerationReview(projectId: string) {
  const queryClient = useQueryClient()
  const reviewQuery = useQuery(generationReviewQueryOptions(projectId))
  const review = reviewQuery.data ?? null

  function setReview(next: GenerationReview | null): void {
    queryClient.setQueryData(generationReviewQueryKeys.project(projectId), next)
  }

  // Publishing and discarding change main or the branch list.
  async function refreshSite(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: docsBranchQueryKeys.project(projectId) }),
      queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.project(projectId) }),
    ])
  }

  // A decision rewrites pages on the review branch, so the editor reloads them.
  async function refreshReviewBranch(branchId: string): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.content(projectId, branchId) }),
      queryClient.invalidateQueries({ queryKey: docsBranchQueryKeys.status(projectId, branchId) }),
    ])
  }

  const decideMutation = useMutation({
    mutationFn: ({ decisions, discardEdits }: ReviewDecisionInput) =>
      decideGenerationReviewPages(projectId, {
        decisions: [...decisions],
        ...(discardEdits ? { discardEdits } : {}),
      }),
    onSuccess: (next) => {
      setReview(next)
      if (next.branch) void refreshReviewBranch(next.branch.id)
    },
  })
  const publishMutation = useMutation({
    mutationFn: (current: GenerationReview): Promise<PublishGenerationReviewResult> => {
      if (!current.branch) throw new Error("This review has no branch to publish.")
      return publishGenerationReview(projectId, {
        expectedBaseVersionId: current.branch.baseVersionId,
        expectedRevision: current.branch.revision,
      })
    },
    onSuccess: async () => {
      setReview(null)
      await refreshSite()
    },
  })
  const discardMutation = useMutation({
    mutationFn: () => discardGenerationReview(projectId),
    onSuccess: async () => {
      setReview(null)
      await refreshSite()
    },
  })

  return {
    reviewQuery,
    review,
    /** Saves a decision. A failure shows as `decideError`; edits at risk wait for the person to confirm. */
    decide: (decision: ReviewDecisionInput): Promise<ReviewDecisionResult> =>
      decideMutation.mutateAsync(decision).then(
        () => "saved" as const,
        (error: unknown) => (isEditsAtRisk(error) ? "edits_at_risk" : "failed"),
      ),
    /** True while decisions save. */
    isDeciding: decideMutation.isPending,
    /** The pages whose decisions are saving, so only their controls show progress. */
    decidingHrefs: decideMutation.isPending ? decideMutation.variables.decisions.map(({ href }) => href) : NO_HREFS,
    decideError:
      decideMutation.error && !isEditsAtRisk(decideMutation.error)
        ? getErrorMessage(decideMutation.error, "The decision could not be saved.")
        : null,
    publish: (current: GenerationReview) => publishMutation.mutateAsync(current),
    isPublishing: publishMutation.isPending,
    publishError: publishMutation.error
      ? getErrorMessage(publishMutation.error, "The review could not be published.")
      : null,
    discard: () => discardMutation.mutateAsync(),
    isDiscarding: discardMutation.isPending,
    discardError: discardMutation.error
      ? getErrorMessage(discardMutation.error, "The review could not be discarded.")
      : null,
  }
}
