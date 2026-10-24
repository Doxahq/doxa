// @vitest-environment jsdom
import { useState, type ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { DocsSyncPreview } from "@doxahq/contracts/docs-branches"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { ApiRequestError } from "~/lib/api-errors"
import { SyncDialog } from "~/components/dashboard/content/branches/sync-dialog"

const getDocsBranchSyncPreview = vi.fn<() => Promise<DocsSyncPreview>>()
const syncDocsBranch = vi.fn<() => Promise<{ revision: number; changeCount: number }>>()

vi.mock("~/lib/docs-branches-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/docs-branches-api")>()),
  getDocsBranchSyncPreview: () => getDocsBranchSyncPreview(),
  syncDocsBranch: () => syncDocsBranch(),
}))

beforeEach(() => {
  getDocsBranchSyncPreview.mockReset()
  syncDocsBranch.mockReset()
  getDocsBranchSyncPreview.mockResolvedValue(syncPreview())
  syncDocsBranch.mockResolvedValue({ revision: 3, changeCount: 2 })
})

afterEach(cleanup)

describe("synchronization dialog", () => {
  test("requires every resolution and the bulk actions set every unit", async () => {
    const user = userEvent.setup()
    renderDialog()

    await screen.findByText("Home")
    const synchronize = await screen.findByRole("button", { name: "Synchronize" })
    expect(synchronize.hasAttribute("disabled")).toBe(true)

    await user.click(requiredItem(screen.getAllByRole("button", { name: "Keep mine" }), 0))
    expect(synchronize.hasAttribute("disabled")).toBe(true)
    await user.click(requiredItem(screen.getAllByRole("button", { name: "Keep main" }), 1))
    expect(synchronize.hasAttribute("disabled")).toBe(false)

    await user.click(screen.getByRole("button", { name: "Keep all main (fast sync)" }))
    await user.click(screen.getByRole("button", { name: "Keep all main" }))
    const mainChoices = screen.getAllByRole("button", { name: "Keep main" })
    expect(mainChoices.every((button) => button.getAttribute("aria-pressed") === "true")).toBe(true)
  })

  test("a 409 reload keeps choices for conflicts that still exist", async () => {
    const user = userEvent.setup()
    getDocsBranchSyncPreview
      .mockResolvedValueOnce(syncPreview())
      .mockResolvedValueOnce({
        ...syncPreview(),
        mainVersionId: "20000000-0000-4000-8000-000000000003",
        conflicts: [requiredItem(syncPreview().conflicts, 0)],
      })
    syncDocsBranch.mockRejectedValueOnce(
      new ApiRequestError("Main changed.", 409, "main_changed"),
    )
    renderDialog()

    await screen.findByText("Home")
    await user.click(requiredItem(screen.getAllByRole("button", { name: "Keep mine" }), 0))
    await user.click(requiredItem(screen.getAllByRole("button", { name: "Keep main" }), 1))
    await user.click(screen.getByRole("button", { name: "Synchronize" }))

    await waitFor(() => expect(screen.queryByText("Site settings")).toBeNull())
    expect(screen.getByRole("button", { name: "Keep mine" }).getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByText(/plan was reloaded/)).toBeTruthy()
  })

  test("keyboard focus returns to the control that opened the dialog", async () => {
    const user = userEvent.setup()
    render(<DialogHarness />, { wrapper: queryWrapper() })
    const trigger = screen.getByRole("button", { name: "Open synchronization" })
    trigger.focus()
    await user.keyboard("{Enter}")
    expect(await screen.findByRole("dialog")).toBeTruthy()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })
})

function renderDialog() {
  render(
    <SyncDialog
      projectId="project-1"
      branch="main"
      pages={[{ href: "/", title: "Home" }]}
      open
      onOpenChange={() => undefined}
    />,
    { wrapper: queryWrapper() },
  )
}

function DialogHarness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open synchronization</button>
      <SyncDialog
        projectId="project-1"
        branch="main"
        pages={[]}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  )
}

function queryWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

function syncPreview(): DocsSyncPreview {
  return {
    mainVersionId: "20000000-0000-4000-8000-000000000002",
    behind: true,
    autoResolvedCount: 1,
    conflicts: [
      {
        unit: "page",
        key: "page:/",
        href: "/",
        title: "Home",
        mine: "modified",
        main: "modified",
      },
      { unit: "site_settings", key: "site_settings" },
    ],
  }
}

function requiredItem<Item>(items: readonly Item[], index: number): Item {
  const item = items[index]
  if (!item) throw new Error(`Expected item ${index}.`)
  return item
}
