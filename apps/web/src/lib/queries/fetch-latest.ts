import {
  isCancelledError,
  type FetchQueryOptions,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query"

/** Each attempt waits for a real request, so this only ends a read that keeps being replaced. */
const MAX_ATTEMPTS = 5

/**
 * The data as the server holds it now. Null when it cannot load.
 *
 * A read joins a refresh that already runs. A newer refresh cancels that one
 * and rejects the read, although the answer is still on its way. So the read
 * joins the newer refresh, and only a real failure gives null.
 */
export async function fetchLatest<TData, TKey extends QueryKey>(
  queryClient: QueryClient,
  options: FetchQueryOptions<TData, Error, TData, TKey>,
): Promise<TData | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await queryClient.fetchQuery({ ...options, staleTime: 0 })
    } catch (error) {
      if (!isCancelledError(error)) return null
    }
  }
  return null
}
