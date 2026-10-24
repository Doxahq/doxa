// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { DocsBranchPageSources } from "@doxahq/contracts/docs-branches"
import { afterEach, describe, expect, test, vi } from "vitest"

import { BranchPageDiffPane } from "~/components/dashboard/content/branches/branch-page-diff-pane"

const branchId = "10000000-0000-4000-8000-000000000001"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderPane(props: { onClose?: () => void; onBackToRequest?: () => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return render(
    <BranchPageDiffPane
      projectId="project-1"
      branch={branchId}
      branchName="agent-docs"
      page={{ href: "/install", title: "Install", change: "edited" }}
      onClose={props.onClose ?? (() => undefined)}
      onBackToRequest={props.onBackToRequest}
    />,
    { wrapper },
  )
}

describe("branch page diff pane", () => {
  test("shows the main source on the left and the branch source on the right", async () => {
    const sources: DocsBranchPageSources = {
      href: "/install",
      title: "Install",
      change: "edited",
      before: "# Install\n\nRun the setup script.\n",
      after: "# Install\n\nRun the bootstrap command.\n",
    }
    const fetchMock = vi.fn(async () => Response.json(sources))
    vi.stubGlobal("fetch", fetchMock)
    renderPane()

    expect(screen.getByRole("region", { name: "Diff of Install" })).toBeTruthy()
    expect(screen.getByText("Edited")).toBeTruthy()
    expect(screen.getByText("main")).toBeTruthy()
    expect(screen.getByText("agent-docs")).toBeTruthy()
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toContain(`/branches/${branchId}/diff/page?href=%2Finstall`)

    await waitFor(() => {
      expect(screen.getByLabelText("Main source").textContent).toContain("Run the setup script.")
    })
    const branchSource = screen.getByLabelText("Branch source")
    expect(branchSource.textContent).toContain("Run the bootstrap command.")
    expect(branchSource.getAttribute("contenteditable")).toBe("false")
  })

  test("closes, and goes back to the request", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Promise<Response>(() => undefined)))
    const onClose = vi.fn()
    const onBackToRequest = vi.fn()
    renderPane({ onClose, onBackToRequest })

    fireEvent.click(screen.getByRole("button", { name: "Close diff" }))
    fireEvent.click(screen.getByRole("button", { name: "Back to request" }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(onBackToRequest).toHaveBeenCalledOnce()
  })

  test("shows the error when the sources cannot load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { message: "This page has no changes on the branch." } }, { status: 404 })),
    )
    renderPane()

    expect(await screen.findByText("This page has no changes on the branch.")).toBeTruthy()
  })
})
