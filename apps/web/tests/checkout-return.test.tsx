// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react"
import { Activity, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { BillingAccountSummary } from "@doxahq/contracts/billing"

const billingApi = vi.hoisted(() => ({
  listBillingAccounts: vi.fn(),
  syncBillingCheckout: vi.fn(),
}))
vi.mock("~/lib/billing-api", async (importOriginal) => ({ ...(await importOriginal<object>()), ...billingApi }))
vi.mock("~/lib/dashboard/use-projects-summary", () => ({
  useProjectsSummary: () => ({ projects: [], isPending: false }),
}))
vi.mock("~/components/dashboard/new-project/generate-from-repository-dialog", () => ({
  GenerateFromRepositoryDialog: ({ open }: { open: boolean }) => (open ? <div role="dialog">Repository dialog</div> : null),
}))
vi.mock("~/components/dashboard/new-project/create-project-dialog", () => ({ CreateProjectDialog: () => null }))
vi.mock("~/components/dashboard/new-project/mcp-connect-card", () => ({ McpConnectCard: () => null }))
vi.mock("~/lib/auth/dashboard-auth-context", () => ({
  useDashboardAuth: () => ({ user: { id: "user-1", name: null, email: null, image: null }, isPending: false }),
}))
// The top bar needs the dashboard shell (sidebar); the page body does not.
vi.mock("~/components/dashboard/dashboard-header", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  DashboardHeader: () => null,
}))

import { NewProjectPage } from "~/components/dashboard/new-project-page"
import { currentDashboardReturnPath } from "~/lib/dashboard/checkout-return"
import { parseNewProjectSearch } from "~/lib/dashboard/new-project-search"
import { useCheckoutReturn } from "~/lib/dashboard/use-checkout-return"
import { billingQueryKeys } from "~/lib/queries/billing"
import { TRIAL_ACCOUNT } from "./fixtures/billing"

function personal(plan: string): BillingAccountSummary {
  return { id: TRIAL_ACCOUNT.id, ownerKind: "user", ownerId: "user-1", name: null, plan, canManage: true }
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(cleanup)

describe("useCheckoutReturn", () => {
  test("syncs a returned Checkout once, then removes the parameter and refreshes the billing reads", async () => {
    billingApi.syncBillingCheckout.mockResolvedValue(TRIAL_ACCOUNT)
    const client = newClient()
    const invalidate = vi.spyOn(client, "invalidateQueries")
    const onHandled = vi.fn()
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>

    const { result, rerender } = renderHook(({ sessionId }) => useCheckoutReturn(sessionId, onHandled), {
      wrapper,
      initialProps: { sessionId: "cs_1" as string | null },
    })
    rerender({ sessionId: "cs_1" })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    await waitFor(() => expect(onHandled).toHaveBeenCalledOnce())
    rerender({ sessionId: null })
    rerender({ sessionId: "cs_1" })

    expect(billingApi.syncBillingCheckout).toHaveBeenCalledOnce()
    expect(billingApi.syncBillingCheckout).toHaveBeenCalledWith("cs_1")
    expect(client.getQueryData(billingQueryKeys.detail(TRIAL_ACCOUNT.id))).toEqual(TRIAL_ACCOUNT)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: billingQueryKeys.accounts() })
    expect(onHandled).toHaveBeenCalledOnce()
  })

  test("a page hidden and shown again while the sync runs still ends on the result (it stayed on pending)", async () => {
    let finish: (detail: typeof TRIAL_ACCOUNT) => void = () => undefined
    billingApi.syncBillingCheckout.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    const client = newClient()
    const onHandled = vi.fn()
    let state: ReturnType<typeof useCheckoutReturn> | null = null
    function Probe() {
      state = useCheckoutReturn("cs_1", onHandled)
      return null
    }
    const view = (mode: "visible" | "hidden") => (
      <QueryClientProvider client={client}>
        <Activity mode={mode}>
          <Probe />
        </Activity>
      </QueryClientProvider>
    )

    const { rerender } = render(view("visible"))
    await waitFor(() => expect(billingApi.syncBillingCheckout).toHaveBeenCalledOnce())
    expect(state).toMatchObject({ isPending: true, isSuccess: false })
    // Hiding unsubscribes the page's observers, showing subscribes them again.
    rerender(view("hidden"))
    rerender(view("visible"))
    finish(TRIAL_ACCOUNT)

    await waitFor(() => expect(state).toMatchObject({ isPending: false, isSuccess: true }))
    await waitFor(() => expect(onHandled).toHaveBeenCalledOnce())
    expect(billingApi.syncBillingCheckout).toHaveBeenCalledOnce()
  })

  test("does nothing without a session", () => {
    const client = newClient()
    const onHandled = vi.fn()
    renderHook(() => useCheckoutReturn(null, onHandled), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    })
    expect(billingApi.syncBillingCheckout).not.toHaveBeenCalled()
    expect(onHandled).not.toHaveBeenCalled()
  })
})

describe("Checkout return paths", () => {
  test("a trial button returns to its own dashboard page, without a stale checkout parameter", () => {
    expect(currentDashboardReturnPath({ pathname: "/dashboard/projects/p1/overview", search: "" })).toBe(
      "/dashboard/projects/p1/overview",
    )
    expect(currentDashboardReturnPath({ pathname: "/dashboard/projects/p1/doxabot", search: "?checkout=cs_1&tab=a" })).toBe(
      "/dashboard/projects/p1/doxabot?tab=a",
    )
    // Outside the dashboard, the API's default (the billing page) applies.
    expect(currentDashboardReturnPath({ pathname: "/", search: "" })).toBeUndefined()
    expect(currentDashboardReturnPath(undefined)).toBeUndefined()
  })

  test("the new project page reads the Checkout session", () => {
    expect(parseNewProjectSearch({ start: "repository", checkout: "cs_1" })).toEqual({ start: "repository", checkout: "cs_1" })
    expect(parseNewProjectSearch({ checkout: "" })).toEqual({})
    expect(parseNewProjectSearch({ checkout: 1 })).toEqual({})
  })
})

async function renderOnboarding(url: string) {
  const rootRoute = createRootRoute()
  const newRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/dashboard/projects/new",
    validateSearch: parseNewProjectSearch,
    component: NewProjectPage,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([newRoute]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  render(
    <QueryClientProvider client={newClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  await screen.findByRole("heading", { name: "Create your first docs project" })
  return router
}

describe("onboarding after the Pro trial's Checkout", () => {
  test("syncs the trial, drops the parameter and opens the repository dialog", async () => {
    let plan = "free"
    billingApi.listBillingAccounts.mockImplementation(async () => ({ enforcement: "on", accounts: [personal(plan)] }))
    billingApi.syncBillingCheckout.mockImplementation(async () => {
      plan = "pro"
      return TRIAL_ACCOUNT
    })

    const router = await renderOnboarding("/dashboard/projects/new?start=repository&checkout=cs_1")
    // The reserved card state, never the Free card, while the sync runs.
    expect(screen.queryByRole("button", { name: "Start 7-day Pro trial" })).toBeNull()

    expect(await screen.findByRole("dialog")).toBeTruthy()
    expect(billingApi.syncBillingCheckout).toHaveBeenCalledOnce()
    expect(billingApi.syncBillingCheckout).toHaveBeenCalledWith("cs_1")
    await waitFor(() => expect(router.state.location.search).toEqual({ start: "repository" }))
  })

  test("webhook lag: no dialog and no Free card until the plan arrives, then the dialog opens", async () => {
    let plan = "free"
    billingApi.listBillingAccounts.mockImplementation(async () => ({ enforcement: "on", accounts: [personal(plan)] }))
    // The provider has not finished the Checkout yet: the account is still Free.
    billingApi.syncBillingCheckout.mockResolvedValue({ ...TRIAL_ACCOUNT, plan: "free", subscription: null })

    const router = await renderOnboarding("/dashboard/projects/new?start=repository&checkout=cs_2")
    await waitFor(() => expect(router.state.location.search).toEqual({ start: "repository" }))
    await waitFor(() => expect(billingApi.listBillingAccounts.mock.calls.length).toBeGreaterThan(1))
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.queryByRole("button", { name: "Start 7-day Pro trial" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Generate from a repository" })).toBeNull()

    plan = "pro"
    expect(await screen.findByRole("dialog", {}, { timeout: 5_000 })).toBeTruthy()
    expect(billingApi.syncBillingCheckout).toHaveBeenCalledOnce()
  }, 10_000)
})
