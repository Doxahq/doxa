import type { ReactNode } from "react"
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
  environmentManager,
} from "@tanstack/react-query"

import { inlinePlanLimitKeysOf, reportBillingDenial } from "~/lib/dashboard/billing-denials"

function makeQueryClient() {
  return new QueryClient({
    // A billing denial (402 credits, 403 plan limit) of any mutation opens the
    // dashboard's billing dialog. The mutation's own error handling still runs.
    // A mutation names the plan limits that it shows itself in its `meta`.
    mutationCache: new MutationCache({
      onError: (error, _variables, _result, mutation) =>
        void reportBillingDenial(error, { inlinePlanLimitKeys: inlinePlanLimitKeysOf(mutation.meta) }),
    }),
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
