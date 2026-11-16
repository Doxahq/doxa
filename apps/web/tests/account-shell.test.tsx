// @vitest-environment jsdom
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { BillingAccountList } from "@doxahq/contracts/billing"

const billingApi = vi.hoisted(() => ({
  listBillingAccounts: vi.fn(),
  getBillingAccount: vi.fn(),
  listBillingInvoices: vi.fn(),
  listBillingLedgerEntries: vi.fn(),
}))
vi.mock("~/lib/billing-api", async (importOriginal) => ({ ...(await importOriginal<object>()), ...billingApi }))
vi.mock("~/lib/dashboard/use-projects-summary", () => ({
  useProjectsSummary: () => ({ projects: [{ id: "p1", name: "Acme Payments" }], isPending: false }),
}))
vi.mock("~/lib/auth/dashboard-auth-context", () => ({
  useDashboardAuth: () => ({ user: { id: "user-1", name: "Sam Lee", email: "sam@acme.dev", image: null }, isPending: false, signOut: vi.fn() }),
}))
// The Account view reads only `view` from the shell; the real provider needs the sidebar.
vi.mock("~/lib/dashboard/shell-context", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useShell: () => ({ view: "account" }),
}))
// The top bar needs the dashboard shell (sidebar); the page body does not.
vi.mock("~/components/dashboard/shell/top-bar", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  AccountTopBar: () => null,
}))

import { BillingAccountsPage } from "~/components/dashboard/billing/billing-accounts-page"
import { BillingCreditsPage } from "~/components/dashboard/billing/billing-credits-page"
import { AccountSidebarView } from "~/components/dashboard/shell/account-sidebar-view"
import { createApiError } from "~/lib/api-errors"
import { sidebarViewForPath } from "~/lib/dashboard/shell-context"
import { Route as CreditsRoute } from "~/routes/dashboard/billing/$accountId/credits"
import { ACTIVE_WITH_DEBT, INVOICES, LEDGER_ENTRIES, PERSONAL_SUMMARY, TEAM_SUMMARY } from "./fixtures/billing"
import { newQueryClient, renderInRouter } from "./fixtures/render-in-router"

const PERSONAL_ID = PERSONAL_SUMMARY.id

function accounts(list: BillingAccountList["accounts"]): BillingAccountList {
  return { enforcement: "on", accounts: list }
}

beforeEach(() => {
  vi.clearAllMocks()
  billingApi.listBillingAccounts.mockResolvedValue(accounts([PERSONAL_SUMMARY]))
})
afterEach(cleanup)

describe("the Account sidebar view", () => {
  test("shows on Account settings, Teams and every billing page, and nowhere else", () => {
    for (const path of [
      "/dashboard/settings",
      "/dashboard/teams",
      "/dashboard/teams/t1",
      "/dashboard/billing",
      `/dashboard/billing/${PERSONAL_ID}`,
      `/dashboard/billing/${PERSONAL_ID}/credits`,
    ]) {
      expect(sidebarViewForPath(path), path).toBe("account")
    }
    expect(sidebarViewForPath("/dashboard/projects/p1/project")).toBe("project")
    expect(sidebarViewForPath("/dashboard/projects/p1/site/appearance")).toBe("site")
    expect(sidebarViewForPath("/dashboard/settingsx")).toBe("project")
  })

  test("its items: Account settings, Teams, and BILLING with the personal account's two pages", async () => {
    renderInRouter(<AccountSidebarView projectId="p1" />, { path: `/dashboard/billing/${PERSONAL_ID}/credits` })
    const nav = await screen.findByRole("navigation", { name: "Account" })
    expect(within(nav).getByRole("link", { name: "Account settings" }).getAttribute("href")).toBe("/dashboard/settings")
    expect(within(nav).getByRole("link", { name: "Teams" }).getAttribute("href")).toBe("/dashboard/teams")
    expect(await within(nav).findByText("Billing")).toBeTruthy()
    const plan = within(nav).getByRole("link", { name: "Plan and invoices" })
    const credits = within(nav).getByRole("link", { name: "AI credits" })
    expect(plan.getAttribute("href")).toBe(`/dashboard/billing/${PERSONAL_ID}`)
    expect(credits.getAttribute("href")).toBe(`/dashboard/billing/${PERSONAL_ID}/credits`)
    expect(credits.getAttribute("aria-current")).toBe("page")
    expect(plan.getAttribute("aria-current")).toBeNull()
    expect(screen.getByText("Account")).toBeTruthy()
    // No plan badges in the sidebar.
    expect(screen.queryByText(/^(Pro|Free|Trial)$/i)).toBeNull()
  })

  test("the back link returns to the last project", async () => {
    const { router } = renderInRouter(<AccountSidebarView projectId="p1" />, { path: "/dashboard/settings" })
    const back = await screen.findByRole("button", { name: "Back to Acme Payments" })
    expect(within(screen.getByRole("navigation", { name: "Account" })).getByRole("link", { name: "Account settings" }).getAttribute("aria-current")).toBe("page")
    await userEvent.click(back)
    await waitFor(() => expect(router.state.location.pathname).toBe("/dashboard/projects/p1/project"))
  })

  test("with no project, the back link opens the new project page", async () => {
    const { router } = renderInRouter(<AccountSidebarView projectId={null} />, { path: "/dashboard/settings" })
    await userEvent.click(await screen.findByRole("button", { name: "Back to new project" }))
    await waitFor(() => expect(router.state.location.pathname).toBe("/dashboard/projects/new"))
  })

  test("without billing on the server, BILLING is hidden", async () => {
    billingApi.listBillingAccounts.mockRejectedValue(
      createApiError(503, { error: { message: "Billing is not configured on this server.", details: { code: "billing_not_configured" } } }),
    )
    const { client } = renderInRouter(<AccountSidebarView projectId="p1" />, { path: "/dashboard/settings" })
    await screen.findByRole("navigation", { name: "Account" })
    await waitFor(() => expect(client.getQueryState(["billing", "accounts"])?.status).toBe("error"))
    expect(screen.queryByRole("link", { name: "Plan and invoices" })).toBeNull()
  })
})

function renderBillingIndex() {
  const rootRoute = createRootRoute()
  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: "/dashboard/billing",
    component: () => <BillingAccountsPage upgradeInterval={null} />,
  })
  const account = createRoute({
    getParentRoute: () => rootRoute,
    path: "/dashboard/billing/$accountId",
    component: function AccountPage() {
      const { accountId } = account.useParams()
      return <p>Plan and invoices of {accountId}</p>
    },
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([index, account]),
    history: createMemoryHistory({ initialEntries: ["/dashboard/billing"] }),
  })
  render(
    <QueryClientProvider client={newQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

describe("/dashboard/billing", () => {
  test("with one account the viewer manages, it opens that account's Plan and invoices", async () => {
    const router = renderBillingIndex()
    expect(await screen.findByText(`Plan and invoices of ${PERSONAL_ID}`)).toBeTruthy()
    expect(router.state.location.pathname).toBe(`/dashboard/billing/${PERSONAL_ID}`)
  })

  test("with more accounts, it lists them", async () => {
    billingApi.listBillingAccounts.mockResolvedValue(accounts([PERSONAL_SUMMARY, TEAM_SUMMARY]))
    renderBillingIndex()
    expect(await screen.findByText("Personal account")).toBeTruthy()
    expect(screen.getByText("Acme team")).toBeTruthy()
  })
})

describe("/dashboard/billing/$accountId/credits", () => {
  test("the route opens AI credits for its account", async () => {
    billingApi.getBillingAccount.mockResolvedValue(ACTIVE_WITH_DEBT)
    billingApi.listBillingInvoices.mockResolvedValue({ invoices: INVOICES, nextCursor: null })
    billingApi.listBillingLedgerEntries.mockResolvedValue({ entries: LEDGER_ENTRIES, nextCursor: null })
    const rootRoute = createRootRoute()
    const credits = createRoute({
      getParentRoute: () => rootRoute,
      path: "/dashboard/billing/$accountId/credits",
      component: function CreditsRouteView() {
        const { accountId } = credits.useParams()
        return <BillingCreditsPage accountId={accountId} />
      },
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([credits]),
      history: createMemoryHistory({ initialEntries: [`/dashboard/billing/${ACTIVE_WITH_DEBT.id}/credits`] }),
    })
    render(
      <QueryClientProvider client={newQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )
    expect(await screen.findByRole("heading", { name: "AI credits" })).toBeTruthy()
    // The route file loads the same page, with the page-shaped skeleton while it loads.
    expect(CreditsRoute.options.component).toBeDefined()
    expect(CreditsRoute.options.pendingComponent).toBeDefined()
    expect(billingApi.getBillingAccount).toHaveBeenCalledWith(ACTIVE_WITH_DEBT.id)
    for (const name of ["This month", "Pay-as-you-go", "Cap per run", "Credit history"]) {
      expect(screen.getByRole("heading", { name })).toBeTruthy()
    }
  })
})
