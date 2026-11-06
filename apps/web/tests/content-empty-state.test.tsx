// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { ContentEmptyState } from "~/components/dashboard/content/content-empty-state"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"

const PROJECT_ID = "project-1"
const generations = vi.hoisted(() => ({
  current: { activeGeneration: null as { id: string } | null, isPending: false },
}))

vi.mock("~/lib/dashboard/use-project-generations", () => ({
  useProjectGenerations: () => generations.current,
}))

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, params }: { children: ReactNode; params: { generationId: string } }) => (
    <a href={`/generations/${params.generationId}`}>{children}</a>
  ),
}))

function ui(queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <ContentEmptyState projectId={PROJECT_ID} />
    </QueryClientProvider>
  )
}

describe("content empty state", () => {
  beforeEach(() => {
    generations.current = { activeGeneration: null, isPending: false }
  })

  afterEach(cleanup)

  test("points to the running generation and says that the pages come after it", () => {
    generations.current = { activeGeneration: { id: "job-1" }, isPending: false }

    render(ui(new QueryClient()))

    expect(screen.getByText("Generating your docs")).toBeTruthy()
    expect(screen.getByText(/Your pages appear here when the generation is done/)).toBeTruthy()
    expect(screen.getByRole("link", { name: "View generation" }).getAttribute("href")).toBe("/generations/job-1")
  })

  test("asks for a generation when none is running", () => {
    render(ui(new QueryClient()))

    expect(screen.getByText("No documentation yet")).toBeTruthy()
    expect(screen.queryByRole("link")).toBeNull()
  })

  test("shows neither message until the generations load", () => {
    generations.current = { activeGeneration: null, isPending: true }

    render(ui(new QueryClient()))

    expect(screen.queryByText("No documentation yet")).toBeNull()
    expect(screen.queryByText("Generating your docs")).toBeNull()
  })

  test("loads the project data again when the generation ends", () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    generations.current = { activeGeneration: { id: "job-1" }, isPending: false }
    const { rerender } = render(ui(queryClient))
    expect(invalidate).not.toHaveBeenCalled()

    generations.current = { activeGeneration: null, isPending: false }
    rerender(ui(queryClient))

    expect(invalidate).toHaveBeenCalledOnce()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: dashboardQueryKeys.project(PROJECT_ID) })
  })
})
