import { useRef } from "react"

interface LoadingQuery {
  isPending: boolean
}

/**
 * Where a page is in loading the data of its current subject (`key`, for
 * example the billing account in the URL):
 * - `first`: nothing settled yet. The page shows its skeleton.
 * - `switching`: an earlier key settled, the current key not yet. The page
 *   keeps its frame (heading, switcher) and shows a spinner for the body, so
 *   that the empty states of the new subject do not flash.
 * - `ready`: every query of the current key settled once, with data or with
 *   an error. It stays `ready` for that key.
 *
 * A key does not go back from `ready`: a section that mounts with the page
 * subscribes to the same query, and a failed query without data refetches on
 * that mount and is pending again. A page that followed `isPending` would then
 * hide the section, the refetch would fail, the section would mount again, and
 * the page would loop on its loading view forever, hiding the error.
 */
export type LoadPhase = "first" | "switching" | "ready"

export function useLoadPhase(queries: readonly LoadingQuery[], key: string): LoadPhase {
  const settledRef = useRef<{ key: string } | null>(null)
  if (settledRef.current?.key !== key && queries.every((query) => !query.isPending)) settledRef.current = { key }
  if (settledRef.current === null) return "first"
  return settledRef.current.key === key ? "ready" : "switching"
}

/** True until every query has settled once, with data or with an error. Then false for good. */
export function useIsFirstLoad(queries: readonly LoadingQuery[]): boolean {
  return useLoadPhase(queries, "") === "first"
}
