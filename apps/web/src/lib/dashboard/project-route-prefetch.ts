import { environmentManager, type QueryClient } from "@tanstack/react-query"

import type { ProjectPrefetchInput, ProjectPrefetchPage } from "~/lib/queries/project-prefetch"

export type { ProjectPrefetchInput, ProjectPrefetchPage }

/**
 * Starts a project page's requests from its route loader, so they run while
 * the page code downloads (or while a link is hovered). It never waits: the
 * loader still waits only for the page code, so a visit still shows the old
 * page, then the page's skeleton, then the page.
 *
 * Route loaders are in the main bundle, which the marketing pages share. The
 * query modules (and the API client and its schemas) load on demand instead.
 * Every dashboard page has loaded them already, so the import resolves at once.
 *
 * The server renders without data for now, so the server starts nothing.
 */
export function startProjectPrefetch(
  queryClient: QueryClient,
  page: ProjectPrefetchPage,
  input: ProjectPrefetchInput,
): void {
  if (environmentManager.isServer()) return
  void import("~/lib/queries/project-prefetch")
    .then(({ prefetchProjectPage }) => prefetchProjectPage(queryClient, page, input))
    // A failed prefetch changes nothing: the page sends its own requests.
    .catch(() => undefined)
}

/** The content page href from the URL search, with the rule of the route's `validateSearch`. */
export function contentPageHrefFromSearch(search: unknown): string | null {
  if (typeof search !== "object" || search === null || !("page" in search)) return null
  const { page } = search
  return typeof page === "string" && page.startsWith("/") ? page : null
}
