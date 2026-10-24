// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { DocsContentPageDto } from "@doxahq/contracts"
import type { PageLock } from "@doxahq/contracts/generation-reviews"
import { afterEach, describe, expect, test, vi } from "vitest"

import { ContentPageRow } from "~/components/dashboard/content/content-page-row"
import { PageSettingsDialog } from "~/components/dashboard/content/page-settings-dialog"

const api = vi.hoisted(() => ({
  locks: [] as PageLock[],
  setPageLock: vi.fn(),
}))

vi.mock("~/lib/page-locks-api", () => ({
  listPageLocks: async () => api.locks,
  setPageLock: (...args: unknown[]) => api.setPageLock(...args),
}))

afterEach(() => {
  cleanup()
  api.locks = []
  api.setPageLock.mockReset()
})

function withQueries(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const overview = { href: "/overview", title: "Overview" }

describe("page settings", () => {
  test("starts unlocked, locks the page on request, and says every change is reviewed", async () => {
    api.setPageLock.mockResolvedValue([{ href: "/overview" }])
    render(withQueries(<PageSettingsDialog projectId="p1" page={overview} onClose={() => undefined} />))

    expect(screen.getByRole("dialog", { name: "Page settings" })).toBeTruthy()
    const lock = within(screen.getByRole("region", { name: "Agent" })).getByRole("switch")
    await waitFor(() => expect((lock as HTMLButtonElement).disabled).toBe(false))
    expect(lock.getAttribute("aria-checked")).toBe("false")
    expect(screen.getByText(/You always review a generation's changes before anything goes live/)).toBeTruthy()

    await userEvent.click(lock)

    expect(api.setPageLock).toHaveBeenCalledWith("p1", { href: "/overview", locked: true })
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"))
  })

  test("unlocks a locked page", async () => {
    api.locks = [{ href: "/overview" }]
    api.setPageLock.mockResolvedValue([])
    render(withQueries(<PageSettingsDialog projectId="p1" page={overview} onClose={() => undefined} />))

    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"))
    await userEvent.click(screen.getByRole("switch"))

    expect(api.setPageLock).toHaveBeenCalledWith("p1", { href: "/overview", locked: false })
  })

  test("marks an agent-locked page in the sidebar and explains the mark", async () => {
    const page = { href: "/overview", title: "Overview", status: "published" } as DocsContentPageDto
    render(
      <ContentPageRow page={page} isSelected={false} home={{ href: "/", pending: false }} onSelect={() => undefined} disabled={false} isLocked />,
    )

    const mark = screen.getByRole("img", { name: "Agent locked" })
    await userEvent.hover(mark)

    expect((await screen.findByRole("tooltip")).textContent).toContain("Generations keep this page as published")
  })
})
