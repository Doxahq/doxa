import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import type { GenerationReviewPage } from "@doxahq/contracts/generation-reviews"

import { toChangesViewPages } from "~/lib/dashboard/generation-changes-model"
import { adjacentReviewHref, reviewPageAt } from "~/lib/dashboard/generation-review-model"
import { useReviewStepKeys } from "~/lib/dashboard/use-content-review"
import { generationChangesQueryOptions } from "~/lib/queries/generation-changes"

/** The pages before and after the open one, for the steps and for J and K. */
export interface ChangesSteps {
  pages: GenerationReviewPage[]
  previousHref: string | null
  nextHref: string | null
}

/**
 * The read-only changes of a pull request preview run. The open page lives in
 * the URL, so a reload or a shared link opens it again. A page that the run
 * did not change opens the first changed page instead.
 */
export function useGenerationChanges(options: {
  projectId: string
  generationId: string
  /** The page in the URL. */
  pageHref: string | null
  /** Puts a page in the URL. */
  onPageShown: (href: string) => void
}) {
  const query = useQuery(generationChangesQueryOptions(options.projectId, options.generationId))
  const changes = query.data ?? null
  const pages = useMemo(() => toChangesViewPages(changes?.pages ?? []), [changes?.pages])
  const focusedPage = reviewPageAt(pages, options.pageHref) ?? pages[0] ?? null
  const focusHref = focusedPage?.href ?? null

  const steps = useMemo<ChangesSteps | null>(
    () =>
      focusHref === null
        ? null
        : {
            pages,
            previousHref: adjacentReviewHref(pages, focusHref, -1),
            nextHref: adjacentReviewHref(pages, focusHref, 1),
          },
    [focusHref, pages],
  )
  useReviewStepKeys(steps, options.onPageShown)

  return { query, changes, pages, focusHref, focusedPage, steps }
}
