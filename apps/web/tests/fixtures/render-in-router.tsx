import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render } from "@testing-library/react"
import type { ReactNode } from "react"

export function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

/**
 * Renders `ui` at `path` inside a memory router and a query client, so links,
 * navigation and the rendered pathname work. Every path matches, and the
 * router records where a navigation went.
 */
export function renderInRouter(ui: ReactNode, options: { path?: string; client?: QueryClient } = {}) {
  const client = options.client ?? newQueryClient()
  const rootRoute = createRootRoute({ component: () => <>{ui}</> })
  const anyPath = createRoute({ getParentRoute: () => rootRoute, path: "$", component: () => null })
  const router = createRouter({
    routeTree: rootRoute.addChildren([anyPath]),
    history: createMemoryHistory({ initialEntries: [options.path ?? "/"] }),
  })
  const result = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { ...result, router, client }
}
