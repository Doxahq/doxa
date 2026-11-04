// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, test, vi } from "vitest"

const api = vi.hoisted(() => ({ getProjectContent: vi.fn() }))
vi.mock("~/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getProjectContent: api.getProjectContent,
}))

import { ContentSidebarSkeleton } from "~/components/dashboard/content/content-sidebar-skeleton"
import { useContentOverviewFailed } from "~/lib/dashboard/use-content-overview-failed"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"

afterEach(cleanup)

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe("the content sidebar skeleton", () => {
  test("announces the loading list and keeps the search box out of reach", () => {
    render(<ContentSidebarSkeleton onBack={vi.fn()} />)
    expect(screen.getByRole("status").textContent).toContain("Loading pages")
    expect(screen.getByRole("button", { name: "Back to overview" })).toBeTruthy()
    expect(screen.queryByRole("textbox")).toBeNull()
  })
})

describe("useContentOverviewFailed", () => {
  test("is false while the overview loads, and never fetches it itself", () => {
    const client = new QueryClient()
    const { result } = renderHook(() => useContentOverviewFailed("p1"), { wrapper: wrapperFor(client) })
    expect(result.current).toBe(false)
    expect(api.getProjectContent).not.toHaveBeenCalled()
  })

  test("stays false once the overview has data, while the editor holds the list back", () => {
    const client = new QueryClient()
    client.setQueryData(dashboardQueryKeys.content("p1", "main"), { pages: [] } as never)
    const { result } = renderHook(() => useContentOverviewFailed("p1"), { wrapper: wrapperFor(client) })
    expect(result.current).toBe(false)
  })

  test("is true when the overview fails, so a project without docs shows no skeleton", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    api.getProjectContent.mockRejectedValueOnce(new Error("No published docs"))
    const { result } = renderHook(() => useContentOverviewFailed("p1"), { wrapper: wrapperFor(client) })
    await client.fetchQuery({ queryKey: dashboardQueryKeys.content("p1", "main"), queryFn: api.getProjectContent }).catch(() => undefined)
    await waitFor(() => expect(result.current).toBe(true))
  })
})
