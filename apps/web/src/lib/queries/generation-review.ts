import { queryOptions } from "@tanstack/react-query"

import { getGenerationReview, getGenerationReviewPage } from "~/lib/generation-review-api"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"
import { fromProjectShell } from "~/lib/queries/project-shell"

export const generationReviewQueryKeys = {
  project: (projectId: string) => [...dashboardQueryKeys.project(projectId), "generation-review"] as const,
  page: (projectId: string, href: string) =>
    [...generationReviewQueryKeys.project(projectId), "page", href] as const,
}

/** The open review of a project, or null when no generation waits for one. */
export function generationReviewQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: generationReviewQueryKeys.project(projectId),
    queryFn: (context) => fromProjectShell(context, projectId, "generationReview", () => getGenerationReview(projectId)),
    staleTime: 5_000,
    retry: false,
  })
}

/** One page, published against generated. Both sides are immutable versions. */
export function generationReviewPageQueryOptions(projectId: string, href: string) {
  return queryOptions({
    queryKey: generationReviewQueryKeys.page(projectId, href),
    queryFn: () => getGenerationReviewPage(projectId, href),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
}
