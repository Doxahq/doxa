// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { BillingAccountDetail } from "@doxahq/contracts/billing"

const billingApi = vi.hoisted(() => ({
  listBillingAccounts: vi.fn(),
  getBillingAccount: vi.fn(),
  listBillingOffers: vi.fn(),
}))
vi.mock("~/lib/billing-api", async (importOriginal) => ({ ...(await importOriginal<object>()), ...billingApi }))

const router = vi.hoisted(() => ({ navigate: vi.fn(), search: {} as Record<string, unknown> }))
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => router.navigate,
  useSearch: () => router.search,
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}))

const access = vi.hoisted(() => ({ current: { kind: "open" } as { kind: string; accountId?: string; canManage?: boolean } }))
vi.mock("~/lib/dashboard/use-ai-access", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNewProjectAiAccess: () => access.current,
}))
vi.mock("~/lib/dashboard/use-projects-summary", () => ({
  useProjectsSummary: () => ({ projects: [], isPending: false }),
}))
vi.mock("~/components/dashboard/dashboard-header", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  DashboardHeader: () => null,
}))
vi.mock("~/components/dashboard/new-project/mcp-connect-card", () => ({ McpConnectCard: () => null }))
vi.mock("~/components/dashboard/new-project/generate-from-repository-dialog", () => ({
  GenerateFromRepositoryDialog: ({ open }: { open: boolean }) => (open ? <p>Repository dialog</p> : null),
}))
vi.mock("~/components/dashboard/new-project/create-project-dialog", () => ({ CreateProjectDialog: () => null }))

import { NewProjectPage } from "~/components/dashboard/new-project-page"
import { AI_ACCESS_LOADING, AI_ACCESS_OPEN } from "~/lib/dashboard/ai-access"
import { FREE_PLAN_NOTE } from "~/lib/dashboard/free-plan-note"
import { trialStartedLine } from "~/lib/dashboard/trial-started-notice"
import { ACTIVE_WITH_DEBT, FREE_ACCOUNT, TRIAL_ACCOUNT } from "./fixtures/billing"

const NOTICE_LINE = "640 AI credits until Nov 17, 2026. No charge until then."

function useAccount(detail: BillingAccountDetail) {
  billingApi.listBillingAccounts.mockResolvedValue({
    enforcement: "on",
    accounts: [{ id: detail.id, ownerKind: "user", ownerId: "user-1", name: null, plan: detail.plan, canManage: true }],
  })
  billingApi.getBillingAccount.mockResolvedValue(detail)
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const page = () => (
    <QueryClientProvider client={client}>
      <NewProjectPage />
    </QueryClientProvider>
  )
  const view = render(page())
  return { rerender: () => view.rerender(page()), container: view.container }
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  access.current = AI_ACCESS_OPEN
  router.search = {}
  useAccount(TRIAL_ACCOUNT)
  billingApi.listBillingOffers.mockResolvedValue([])
})
afterEach(cleanup)

describe("Your Pro trial started", () => {
  test("the line names the trial credits and the trial end, only in the trial", () => {
    expect(trialStartedLine(TRIAL_ACCOUNT)).toBe(NOTICE_LINE)
    expect(trialStartedLine(ACTIVE_WITH_DEBT)).toBeNull()
    expect(trialStartedLine(FREE_ACCOUNT)).toBeNull()
  })

  test("the Checkout return: a notice-shaped bar while the plan waits, then the notice above the heading, kept for the visit", async () => {
    router.search = { checkout: "cs_test_1", start: "repository" }
    access.current = AI_ACCESS_LOADING
    const page = renderPage()
    await settle()
    expect(screen.queryByText("Your Pro trial started")).toBeNull()
    const heading = screen.getByRole("heading", { name: "Create your first docs project" })
    // The bar holds the notice's place before the heading.
    const placeholder = heading.closest("header")?.previousElementSibling
    expect(placeholder?.getAttribute("aria-hidden")).toBe("true")

    // The trial is on: the page drops `checkout` and the plan opens.
    access.current = AI_ACCESS_OPEN
    router.search = { start: "repository" }
    page.rerender()
    const notice = await screen.findByRole("status")
    expect(notice.textContent).toContain("Your Pro trial started")
    expect(screen.getByText(NOTICE_LINE)).toBeTruthy()
    expect(screen.getByRole("link", { name: "View billing" }).getAttribute("href")).toBe("/dashboard/billing")
    expect(notice.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(notice.className).toContain("bg-success/8")
    expect(notice.className).not.toMatch(/border-l/)
    expect(screen.getByText("Repository dialog")).toBeTruthy()

    page.rerender()
    await settle()
    expect(screen.getByText("Your Pro trial started")).toBeTruthy()
  })

  test("a visit without the Checkout return never shows it, even in the trial", async () => {
    renderPage()
    await settle()
    expect(screen.queryByText("Your Pro trial started")).toBeNull()
    expect(billingApi.getBillingAccount).not.toHaveBeenCalled()
  })

  test("a Checkout return whose trial did not start shows no notice", async () => {
    router.search = { checkout: "cs_test_2" }
    access.current = { kind: "needs_pro", accountId: FREE_ACCOUNT.id, canManage: true }
    useAccount(FREE_ACCOUNT)
    renderPage()
    await settle()
    expect(screen.queryByText("Your Pro trial started")).toBeNull()
    expect(screen.queryByRole("status")).toBeNull()
  })

  test("a Checkout return to Pro without a trial shows no notice", async () => {
    router.search = { checkout: "cs_test_3" }
    useAccount(ACTIVE_WITH_DEBT)
    renderPage()
    await settle()
    expect(screen.queryByText("Your Pro trial started")).toBeNull()
  })
})

describe("the Free plan strip", () => {
  test("Free: a strip at the end of the page, with the catalog's domain count and Compare plans", async () => {
    access.current = { kind: "needs_pro", accountId: FREE_ACCOUNT.id, canManage: true }
    const page = renderPage()
    expect(FREE_PLAN_NOTE).toBe(
      "Hosting, the editor, 1 custom domain and MCP are free. Full generations and update runs need Pro.",
    )
    const note = screen.getByText(FREE_PLAN_NOTE)
    expect(screen.getByRole("link", { name: "Compare plans" }).getAttribute("href")).toBe("/dashboard/billing")
    // The last block of the page.
    const strip = note.parentElement
    expect(strip?.nextElementSibling).toBeNull()
    expect(page.container.textContent?.endsWith("Compare plans")).toBe(true)
  })

  test("trial, Pro or billing off: no strip", async () => {
    renderPage()
    await settle()
    expect(screen.queryByText(FREE_PLAN_NOTE)).toBeNull()
    expect(screen.queryByRole("link", { name: "Compare plans" })).toBeNull()
  })
})
