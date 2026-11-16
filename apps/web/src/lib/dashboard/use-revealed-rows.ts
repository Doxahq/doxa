import { useState } from "react"

/** The next page of an infinite query, as a list footer needs it. */
export interface MorePages {
  hasMore: boolean
  isLoadingMore: boolean
  onLoadMore: () => void
}

/**
 * Shows `step` rows first, then `step` more on each "Show older" click. Rows
 * already loaded show at once; past them, the click loads the next page of
 * the infinite query, and its rows show as they arrive.
 */
export function useRevealedRows<Row>(rows: readonly Row[], pages: MorePages, step: number) {
  const [limit, setLimit] = useState(step)
  const visible = rows.slice(0, limit)
  const hasMore = rows.length > limit || pages.hasMore

  function showMore(): void {
    const next = limit + step
    setLimit(next)
    if (next > rows.length && pages.hasMore && !pages.isLoadingMore) pages.onLoadMore()
  }

  return { visible, hasMore, isLoadingMore: pages.isLoadingMore, showMore, reset: () => setLimit(step) }
}

/** The `MorePages` of an infinite query. */
export function morePagesOf(query: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => Promise<unknown> }): MorePages {
  return {
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    onLoadMore: () => void query.fetchNextPage(),
  }
}
