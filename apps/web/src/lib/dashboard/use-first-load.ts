import { useRef } from "react"

interface LoadingQuery {
  isPending: boolean
}

/**
 * True until every query has settled once, with data or with an error. Then
 * false for good.
 *
 * A page shows its skeleton while this is true. It must not go back to the
 * skeleton later: a section that mounts with the page subscribes to the same
 * query, and a failed query without data refetches on that mount and is
 * pending again. A page that followed `isPending` would then hide the section,
 * the refetch would fail, the section would mount again, and the page would
 * loop on its skeleton forever, hiding the error.
 */
export function useIsFirstLoad(queries: readonly LoadingQuery[]): boolean {
  const settledRef = useRef(false)
  if (!settledRef.current && queries.every((query) => !query.isPending)) settledRef.current = true
  return !settledRef.current
}
