// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import { afterEach, describe, expect, test, vi } from "vitest"

import { useIsFirstLoad } from "~/lib/dashboard/use-first-load"

afterEach(cleanup)

describe("useIsFirstLoad", () => {
  test("is true until every query settles once, then stays false", () => {
    const { result, rerender } = renderHook((pending: boolean[]) => useIsFirstLoad(pending.map((isPending) => ({ isPending }))), {
      initialProps: [true, false],
    })
    expect(result.current).toBe(true)
    rerender([false, false])
    expect(result.current).toBe(false)
    // A refetch of a failed query is pending again. The page must not go back to its skeleton.
    rerender([true, false])
    expect(result.current).toBe(false)
  })

  // Regression: a page that followed `isPending` looped forever when a request
  // failed. Its section mounted, refetched the failed query, and made it
  // pending again, which hid the section, and so on.
  test("a page whose section shares a failing query shows the section, without a loop", async () => {
    const queryFn = vi.fn(async () => {
      throw new Error("Request failed")
    })
    const options = { queryKey: ["failing"], queryFn, retry: false }
    function Section() {
      const query = useQuery(options)
      return <p>{query.error ? "Section error" : "Section loading"}</p>
    }
    function Page() {
      const isFirstLoad = useIsFirstLoad([useQuery(options)])
      return isFirstLoad ? <p>Skeleton</p> : <Section />
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByText("Section error")).toBeTruthy())
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)))
    expect(screen.queryByText("Skeleton")).toBeNull()
    expect(queryFn.mock.calls.length).toBeLessThanOrEqual(2)
  })
})
