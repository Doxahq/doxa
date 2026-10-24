import { queryOptions } from "@tanstack/react-query"

import { getGenerationChangedPage, getGenerationChanges } from "~/lib/generation-review-api"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"

export const generationChangesQueryKeys = {
  generation: (projectId: string, generationId: string) =>
    [...dashboardQueryKeys.project(projectId), "generation-changes", generationId] as const,
  page: (projectId: string, generationId: string, href: string) =>
    [...generationChangesQueryKeys.generation(projectId, generationId), "page", href] as const,
}

/**
 * The pages that a pull request preview run changed. Both versions are
 * immutable, so the list never changes once it loads.
 */
export function generationChangesQueryOptions(projectId: string, generationId: string) {
  return queryOptions({
    queryKey: generationChangesQueryKeys.generation(projectId, generationId),
    queryFn: () => getGenerationChanges(projectId, generationId),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
}

/** One changed page, as the base version has it and as the run wrote it. */
export function generationChangedPageQueryOptions(projectId: string, generationId: string, href: string) {
  return queryOptions({
    queryKey: generationChangesQueryKeys.page(projectId, generationId, href),
    queryFn: () => getGenerationChangedPage(projectId, generationId, href),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
}
