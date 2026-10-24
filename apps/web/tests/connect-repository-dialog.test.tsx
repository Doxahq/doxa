// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listRepositories: vi.fn(),
}))

vi.mock("~/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/platform-api")>()),
  listProjects: mocks.listProjects,
  listRepositories: mocks.listRepositories,
}))

const { ConnectRepositoryDialog } = await import("~/components/dashboard/connect-repository-dialog")

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderDialog(open: boolean) {
  mocks.listProjects.mockResolvedValue([])
  mocks.listRepositories.mockResolvedValue([])
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return render(<ConnectRepositoryDialog projectId="p1" open={open} onOpenChange={() => undefined} />, {
    wrapper,
  })
}

describe("ConnectRepositoryDialog", () => {
  test("a closed dialog does not load the repository list", async () => {
    renderDialog(false)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mocks.listRepositories).not.toHaveBeenCalled()
  })

  test("an open dialog loads the repository list", async () => {
    renderDialog(true)
    await waitFor(() => expect(mocks.listRepositories).toHaveBeenCalledTimes(1))
  })
})
