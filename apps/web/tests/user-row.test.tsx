// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, test, vi } from "vitest"

import type { DashboardSessionUser } from "~/lib/auth/dashboard-session"

const auth = vi.hoisted(() => ({ user: null as DashboardSessionUser | null }))
vi.mock("~/lib/auth/dashboard-auth-context", () => ({
  useDashboardAuth: () => ({ user: auth.user, isPending: false, signOut: vi.fn() }),
}))

import { UserRow } from "~/components/dashboard/shell/sidebar-footer"
import { renderInRouter } from "./fixtures/render-in-router"

const SAM = { id: "user-1", name: "Sam Lee", email: "sam@acme.dev", image: null }

afterEach(cleanup)

async function openAccountMenu() {
  await userEvent.click(await screen.findByRole("button", { name: "Account menu" }))
  return screen.findByRole("menu")
}

describe("the account row", () => {
  test("shows the full name, and the email at the top of its menu", async () => {
    auth.user = SAM
    renderInRouter(<UserRow showLinks={false} />)
    const row = await screen.findByRole("button", { name: "Account menu" })
    expect(row.textContent).toContain("Sam Lee")
    expect(row.textContent).not.toContain("sam@acme.dev")
    const menu = await openAccountMenu()
    expect(within(menu).getByText("sam@acme.dev")).toBeTruthy()
  })

  test("a person with no name sees their email in the row, and only once", async () => {
    auth.user = { ...SAM, name: null }
    renderInRouter(<UserRow showLinks={false} />)
    const row = await screen.findByRole("button", { name: "Account menu" })
    expect(row.textContent).toContain("sam@acme.dev")
    const menu = await openAccountMenu()
    expect(within(menu).queryByText("sam@acme.dev")).toBeNull()
  })
})
