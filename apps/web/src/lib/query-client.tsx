import type { ReactNode } from "react"
import {
  QueryClient,
  QueryClientProvider,
  environmentManager,
} from "@tanstack/react-query"

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        staleTime: 15_000,
        refetchOnWindowFocus: false,
      },
    },
  })
}

let browserQueryClient: QueryClient | undefined

/**
 * The QueryClient for one router. The server makes a new client for each
 * request, so one person's data never reaches another person's page. The
 * browser keeps one client for the whole visit, so the cache survives when
 * the router is created again (for example after a hot reload).
 */
export function getQueryClient(): QueryClient {
  if (environmentManager.isServer()) {
    return makeQueryClient()
  }

  browserQueryClient ??= makeQueryClient()
  return browserQueryClient
}

/** Gives the router's QueryClient to the React tree. */
export function AppQueryProvider({ client, children }: { client: QueryClient; children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
