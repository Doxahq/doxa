import { useRouterState } from "@tanstack/react-router"

const PROJECT_ROUTE_ID = "/dashboard/projects/$projectId"

/**
 * True while the router shows the loading view in place of a project page:
 * the page under the project is on screen but its code is not loaded yet. A
 * section inside a page, such as a site settings section, does not count.
 */
export function useIsProjectPagePending(): boolean {
  return useRouterState({
    select: (state) => {
      const index = state.matches.findIndex((match) => match.routeId === PROJECT_ROUTE_ID)
      return index >= 0 && state.matches[index + 1]?.status === "pending"
    },
  })
}
