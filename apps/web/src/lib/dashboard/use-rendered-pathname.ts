import { useRouterState } from "@tanstack/react-router"

/**
 * The pathname of the page on screen.
 *
 * A navigation sets `location` when it starts, but the router keeps the old
 * page on screen until the next route's code and data are loaded. The shell
 * (sidebar view, active items, breadcrumbs) reads this pathname instead, so it
 * changes in the same render as the page.
 */
export function useRenderedPathname(): string {
  return useRouterState({
    select: (state) => state.matches[state.matches.length - 1]?.pathname ?? state.location.pathname,
  })
}
