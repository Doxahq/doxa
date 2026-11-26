// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AnchorHTMLAttributes, ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { BillingAccountSummary, PlanLimitErrorDetails } from "@doxahq/contracts/billing"

const billingApi = vi.hoisted(() => ({
  listBillingAccounts: vi.fn(),
  listBillingOffers: vi.fn(),
  getBillingAccount: vi.fn(),
  createBillingCheckout: vi.fn(),
}))
vi.mock("~/lib/dashboard/workspace-context", async () => {
  const fixture = await import("./fixtures/workspace")
  return fixture.workspaceContextModule(() => fixture.workspaceValue())
})
vi.mock("~/lib/billing-api", async (importOriginal) => ({ ...(await importOriginal<object>()), ...billingApi }))
const openBillingUrl = vi.hoisted(() => vi.fn())
vi.mock("~/lib/dashboard/use-billing-account", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openBillingUrl,
}))

const router = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: {} as Record<string, unknown>,
  params: {} as Record<string, unknown>,
}))
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => router.navigate,
  useSearch: () => router.search,
  useParams: () => router.params,
  Link: ({ to, children, ...props }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))

const access = vi.hoisted(() => ({ current: { kind: "open" } as { kind: string; accountId?: string; canManage?: boolean } }))
vi.mock("~/lib/dashboard/use-ai-access", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNewProjectAiAccess: () => access.current,
  useProjectAiAccess: () => access.current,
}))
vi.mock("~/lib/dashboard/use-projects-summary", () => ({
  useProjectsSummary: () => ({ projects: [], isPending: false }),
}))
vi.mock("~/lib/dashboard/use-project-capabilities", () => ({
  useProjectCapabilities: () => ({ can: () => true }),
}))
vi.mock("~/lib/dashboard/instructions-offer", () => ({ loadInstructionsOffer: async () => false }))

// The page's shell and other dialogs are not under test: small stand-ins report when they open.
vi.mock("~/components/dashboard/dashboard-header", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  DashboardHeader: () => null,
}))
vi.mock("~/components/dashboard/new-project/mcp-connect-card", () => ({ McpConnectCard: () => null }))
vi.mock("~/components/dashboard/new-project/generate-from-repository-dialog", () => ({
  GenerateFromRepositoryDialog: ({ open }: { open: boolean }) => (open ? <p>Repository dialog</p> : null),
}))
vi.mock("~/components/dashboard/new-project/create-project-dialog", () => ({
  CreateProjectDialog: ({ open }: { open: boolean }) => (open ? <p>Create project dialog</p> : null),
}))

import { BillingDenialDialogHost } from "~/components/dashboard/billing/billing-denial-dialog"
import { ProTrialDialogProvider } from "~/components/dashboard/billing/pro-trial-dialog"
import { NewProjectPage } from "~/components/dashboard/new-project-page"
import { createApiError } from "~/lib/api-errors"
import {
  AI_ACCESS_OPEN,
  PRO_GATE_GENERATION,
  PRO_REASON_GENERATION,
  PRO_REASON_REPOSITORY,
  PRO_TRIAL_ASK_OWNER,
  type AiGenerationAccess,
} from "~/lib/dashboard/ai-access"
import { FREE_TEAMS_PER_OWNER_KEY } from "@doxahq/billing/catalog"
import { planLimitSentence, proTrialLimitReason, proTrialUnlocks } from "~/lib/dashboard/billing-model"
import { accountIdFromBillingUrl, planLimitProTrialRequest, reportBillingDenial, showBillingDenial } from "~/lib/dashboard/billing-denials"
import { proTrialRequest, useProTrialDialog, type ProTrialRequest } from "~/lib/dashboard/pro-trial-dialog"
import { PRO_TRIAL_CANCEL_LINE, PRO_TRIAL_TITLE, proOfferPriceView } from "~/lib/dashboard/pro-trial-offer"
import { useGenerationStartFlow } from "~/lib/dashboard/use-generation-start-flow"
import { PRO_FEATURE_GROUPS } from "~/lib/marketing/pricing"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"
import { ENDED_TRIAL_ACCOUNT, FOUNDER_OFFER, FREE_ACCOUNT } from "./fixtures/billing"

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111"
const PROJECT_ID = "33333333-3333-4333-8333-333333333333"
const FREE: AiGenerationAccess = { kind: "needs_pro", accountId: ACCOUNT_ID, canManage: true }
const REQUEST: ProTrialRequest = {
  accountId: ACCOUNT_ID,
  canManage: true,
  reason: PRO_REASON_REPOSITORY,
  feature: "repository_generation",
  returnPath: "/dashboard/projects/new?start=repository",
}

function account(plan: string, canManage = true): BillingAccountSummary {
  return { id: ACCOUNT_ID, ownerKind: "user", ownerId: "user-1", name: null, plan, canManage }
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function renderWithProvider(children: ReactNode, client = newClient()) {
  render(
    <QueryClientProvider client={client}>
      <ProTrialDialogProvider>{children}</ProTrialDialogProvider>
    </QueryClientProvider>,
  )
  return client
}

/** A button that opens the dialog, like a gated action does. */
function OpenButton({ request }: { request: ProTrialRequest }) {
  const dialog = useProTrialDialog()
  return (
    <button type="button" onClick={() => dialog.open(request)}>
      Gated action
    </button>
  )
}

async function openDialog(request: ProTrialRequest = REQUEST) {
  renderWithProvider(<OpenButton request={request} />)
  await userEvent.click(screen.getByRole("button", { name: "Gated action" }))
  return screen.getByRole("dialog")
}

/** The trial terms as [label, value] pairs, in order. */
function termsOf(dialog: HTMLElement): string[][] {
  const terms = within(dialog).getAllByRole("term")
  return terms.map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? ""])
}

/** Lets pending queries and effects settle. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  access.current = AI_ACCESS_OPEN
  router.search = {}
  router.params = {}
  billingApi.listBillingOffers.mockResolvedValue([FOUNDER_OFFER])
  billingApi.getBillingAccount.mockResolvedValue(FREE_ACCOUNT)
  billingApi.createBillingCheckout.mockResolvedValue("https://checkout.example/session")
  billingApi.listBillingAccounts.mockResolvedValue({ enforcement: "on", accounts: [account("free")] })
})
afterEach(() => {
  cleanup()
  showBillingDenial(null)
})

describe("the Pro trial dialog", () => {
  test("Yearly by default: the founder price, the terms, the highlights; Start opens Checkout for the yearly price", async () => {
    const dialog = await openDialog()
    expect(within(dialog).getByRole("heading", { name: PRO_TRIAL_TITLE })).toBeTruthy()
    expect(PRO_TRIAL_TITLE).toBe("Try Doxa Pro free for 7 days")
    expect(within(dialog).getByText(PRO_REASON_REPOSITORY)).toBeTruthy()
    await within(dialog).findByText("$99")
    expect(within(dialog).getByRole("radio", { name: /Yearly/ }).getAttribute("aria-checked")).toBe("true")
    expect(within(dialog).getByText("Billed yearly at $1,188")).toBeTruthy()
    // The founder line names the offer only, with no spots count.
    expect(within(dialog).getByText("Founder price")).toBeTruthy()
    expect(within(dialog).queryByText(/founder spots/)).toBeNull()
    expect(within(dialog).getByText("/ month after the trial")).toBeTruthy()
    expect(termsOf(dialog)).toEqual([
      ["Today", "$0 · card required"],
      ["In the trial", "1,000 AI credits"],
      ["In 7 days", "$1,188 for the year"],
    ])
    expect(within(dialog).getByText(PRO_TRIAL_CANCEL_LINE)).toBeTruthy()

    await userEvent.click(within(dialog).getByRole("button", { name: "Start 7-day Pro trial" }))
    await waitFor(() => expect(openBillingUrl.mock.calls[0]?.[0]).toBe("https://checkout.example/session"))
    expect(billingApi.createBillingCheckout).toHaveBeenCalledWith(
      ACCOUNT_ID,
      FOUNDER_OFFER.prices.year.priceKey,
      "/dashboard/projects/new?start=repository",
    )
  })

  test("an account that already had a trial: no trial promise, and Stripe charges today", async () => {
    billingApi.getBillingAccount.mockResolvedValue(ENDED_TRIAL_ACCOUNT)
    const dialog = await openDialog()
    expect(await within(dialog).findByRole("heading", { name: "Upgrade to Doxa Pro" })).toBeTruthy()
    await within(dialog).findByText("$99")
    expect(within(dialog).getByText("/ month")).toBeTruthy()
    expect(within(dialog).queryAllByRole("term")).toHaveLength(0)
    expect(within(dialog).getByText("This account already had a trial, so Stripe charges the first payment today.")).toBeTruthy()
    expect(within(dialog).queryByText(PRO_TRIAL_CANCEL_LINE)).toBeNull()
    await userEvent.click(within(dialog).getByRole("button", { name: "Upgrade to Pro" }))
    await waitFor(() => expect(billingApi.createBillingCheckout).toHaveBeenCalledOnce())
  })

  test("the interval choice reaches the Checkout price key", async () => {
    const dialog = await openDialog()
    await within(dialog).findByText("$99")
    await userEvent.click(within(dialog).getByRole("radio", { name: "Monthly" }))
    expect(within(dialog).getByText("$129")).toBeTruthy()
    expect(within(dialog).getByText("Billed monthly")).toBeTruthy()
    expect(termsOf(dialog)[2]).toEqual(["In 7 days", "$129 for the first month"])

    await userEvent.click(within(dialog).getByRole("button", { name: "Start 7-day Pro trial" }))
    await waitFor(() => expect(billingApi.createBillingCheckout).toHaveBeenCalledOnce())
    expect(billingApi.createBillingCheckout).toHaveBeenCalledWith(ACCOUNT_ID, FOUNDER_OFFER.prices.month.priceKey, REQUEST.returnPath)
  })

  test("Not now only closes it; Escape closes it too; a new open starts on Yearly again", async () => {
    const dialog = await openDialog()
    await within(dialog).findByText("$99")
    await userEvent.click(within(dialog).getByRole("radio", { name: "Monthly" }))
    await userEvent.click(within(dialog).getByRole("button", { name: "Not now" }))
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(billingApi.createBillingCheckout).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole("button", { name: "Gated action" }))
    const again = screen.getByRole("dialog")
    expect(within(again).getByRole("radio", { name: /Yearly/ }).getAttribute("aria-checked")).toBe("true")
    await userEvent.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(billingApi.createBillingCheckout).not.toHaveBeenCalled()
  })

  test("a member who cannot manage billing sees the reason and who can start the trial, with no Checkout", async () => {
    const dialog = await openDialog({ ...REQUEST, canManage: false })
    expect(within(dialog).getByText(PRO_REASON_REPOSITORY)).toBeTruthy()
    expect(within(dialog).getByText(PRO_TRIAL_ASK_OWNER)).toBeTruthy()
    expect(within(dialog).queryByRole("button", { name: "Start 7-day Pro trial" })).toBeNull()
    expect(within(dialog).queryByRole("radiogroup")).toBeNull()
    // The same features, with no prices, terms or cancel line: they belong to whoever starts the trial.
    expect(within(dialog).getByRole("list", { name: "AI" })).toBeTruthy()
    expect(within(dialog).queryByText("Today")).toBeNull()
    expect(within(dialog).queryByText(PRO_TRIAL_CANCEL_LINE)).toBeNull()
    expect(billingApi.listBillingOffers).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole("button", { name: "Not now" }))
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  test("with no known price, the button stays and no amount shows", async () => {
    billingApi.listBillingOffers.mockResolvedValue([])
    const dialog = await openDialog()
    await within(dialog).findByText("Billed yearly")
    // Only today's "$0" names an amount.
    expect(within(dialog).queryByText(/^\$[1-9]/)).toBeNull()
    expect(within(dialog).getByRole("button", { name: "Start 7-day Pro trial" })).toBeTruthy()
  })

  test("the Pro features come in two labeled groups that never wrap, AI first", async () => {
    const dialog = await openDialog()
    expect(PRO_FEATURE_GROUPS.map((group) => group.label)).toEqual(["AI", "Site and team"])
    for (const group of PRO_FEATURE_GROUPS) {
      const list = within(dialog).getByRole("list", { name: group.label })
      const items = within(list).getAllByRole("listitem")
      expect(items.map((item) => item.textContent)).toEqual([...group.items])
      for (const item of items) expect(item.className).toContain("whitespace-nowrap")
    }
    expect(within(dialog).getByText("10,000 AI credits a month")).toBeTruthy()
    expect(within(dialog).getByText("Unlimited team seats")).toBeTruthy()
    // Two columns from the sm breakpoint, one on a phone.
    const grid = within(dialog).getByRole("list", { name: "AI" }).parentElement?.parentElement
    expect(grid?.className).toContain("sm:grid-cols-2")
    expect(grid?.className).not.toMatch(/(^|\s)grid-cols-2/)
  })

  test("Compare plans opens the pricing page in a new tab", async () => {
    const dialog = await openDialog()
    const link = within(dialog).getByRole("link", { name: "Compare plans (opens in a new tab)" })
    expect(link.getAttribute("href")).toBe("/pricing")
    expect(link.getAttribute("target")).toBe("_blank")
    expect(link.getAttribute("rel")).toContain("noopener")
  })

  test("Start 7-day Pro trial leads with the card icon", async () => {
    const dialog = await openDialog()
    const start = within(dialog).getByRole("button", { name: "Start 7-day Pro trial" })
    expect(start.querySelector("svg")?.getAttribute("class")).toContain("lucide-credit-card")
    expect(start.querySelector(".lucide-sparkles")).toBeNull()
  })

  test("the repository reason names the run", () => {
    expect(PRO_REASON_REPOSITORY).toBe("A full generation from your repository needs Pro.")
  })

  test("the first charge comes from the selected price, and names no amount without one", () => {
    expect(proOfferPriceView(FOUNDER_OFFER, "year").firstCharge).toBe("$1,188 for the year")
    expect(proOfferPriceView(FOUNDER_OFFER, "month").firstCharge).toBe("$129 for the first month")
    expect(proOfferPriceView(null, "year").firstCharge).not.toMatch(/\$/)
  })
})

describe("gated actions", () => {
  test("only needs_pro asks for the dialog: billing off or shadow, Pro, trial and loading run the action", () => {
    expect(proTrialRequest(FREE, PRO_GATE_GENERATION)).toEqual({
      accountId: ACCOUNT_ID,
      canManage: true,
      reason: PRO_REASON_GENERATION,
      feature: "generation",
    })
    expect(proTrialRequest(AI_ACCESS_OPEN, PRO_GATE_GENERATION)).toBeNull()
    expect(proTrialRequest({ kind: "loading" }, PRO_GATE_GENERATION)).toBeNull()
  })

  test("new project, Free: the page shows the normal buttons and never opens the dialog by itself", async () => {
    access.current = FREE
    renderWithProvider(<NewProjectPage />)
    expect(screen.getByRole("heading", { name: "Create your first docs project" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Generate from a repository" })).toBeTruthy()
    await settle()
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.queryByText(PRO_TRIAL_TITLE)).toBeNull()
  })

  test("new project, Free: Generate from a repository opens the dialog and not the repository dialog", async () => {
    access.current = FREE
    renderWithProvider(<NewProjectPage />)
    await userEvent.click(screen.getByRole("button", { name: "Generate from a repository" }))
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText(PRO_REASON_REPOSITORY)).toBeTruthy()
    expect(screen.queryByText("Repository dialog")).toBeNull()

    await within(dialog).findByText("$99")
    await userEvent.click(within(dialog).getByRole("button", { name: "Start 7-day Pro trial" }))
    // Checkout comes back to the new project page, which opens the repository dialog once the plan has AI.
    await waitFor(() =>
      expect(billingApi.createBillingCheckout).toHaveBeenCalledWith(
        ACCOUNT_ID,
        FOUNDER_OFFER.prices.year.priceKey,
        "/dashboard/projects/new?start=repository",
      ),
    )
  })

  test("new project, Free: Create project stays free", async () => {
    access.current = FREE
    renderWithProvider(<NewProjectPage />)
    await userEvent.click(screen.getByRole("button", { name: "Create project" }))
    expect(screen.getByText("Create project dialog")).toBeTruthy()
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  test("new project, billing off, Pro or trial (open): the repository dialog opens and the Pro dialog never does", async () => {
    renderWithProvider(<NewProjectPage />)
    await userEvent.click(screen.getByRole("button", { name: "Generate from a repository" }))
    expect(screen.getByText("Repository dialog")).toBeTruthy()
    expect(screen.queryByText(PRO_TRIAL_TITLE)).toBeNull()
    expect(billingApi.listBillingOffers).not.toHaveBeenCalled()
  })

  test("a generation start on Free opens the dialog and does not start", async () => {
    const generations = { start: vi.fn(async () => null), isStarting: false, startError: null }
    function Probe() {
      const flow = useGenerationStartFlow(PROJECT_ID, generations)
      return (
        <button type="button" onClick={() => void flow.startGeneration()}>
          Generate docs
        </button>
      )
    }
    access.current = FREE
    renderWithProvider(<Probe />)
    await userEvent.click(screen.getByRole("button", { name: "Generate docs" }))
    expect(within(screen.getByRole("dialog")).getByText(PRO_REASON_GENERATION)).toBeTruthy()
    expect(generations.start).not.toHaveBeenCalled()
    cleanup()

    access.current = AI_ACCESS_OPEN
    renderWithProvider(<Probe />)
    await userEvent.click(screen.getByRole("button", { name: "Generate docs" }))
    await waitFor(() => expect(generations.start).toHaveBeenCalledOnce())
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})

function planLimitError(details: Partial<PlanLimitErrorDetails>) {
  return createApiError(403, {
    error: {
      message: "Limit",
      details: { code: "plan_limit", key: "ai.doxabot", limit: false, used: null, plan: null, resetsAt: null, upgradeUrl: null, ...details },
    },
  })
}

function renderDenialHost(client = newClient()) {
  return renderWithProvider(<BillingDenialDialogHost />, client)
}

describe("API refusals", () => {
  test("a 403 plan limit on a Free account opens the Pro trial dialog with the feature reason", async () => {
    renderDenialHost()
    act(() => {
      reportBillingDenial(planLimitError({ plan: "free", upgradeUrl: `https://doxa.test/dashboard/billing/${ACCOUNT_ID}` }))
    })
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("heading", { name: PRO_TRIAL_TITLE })).toBeTruthy()
    expect(within(dialog).getByText("Doxabot needs Pro.")).toBeTruthy()
    expect(screen.queryByText("Plan limit reached")).toBeNull()
  })

  test("a project route without plan or link: the project's billing names the Free account", async () => {
    router.params = { projectId: PROJECT_ID }
    const client = newClient()
    client.setQueryData(dashboardQueryKeys.project(PROJECT_ID), {
      billing: { accountId: ACCOUNT_ID, plan: "free", enforcement: "on" },
    } as never)
    billingApi.listBillingAccounts.mockResolvedValue({ enforcement: "on", accounts: [account("free", false)] })
    renderDenialHost(client)
    act(() => {
      reportBillingDenial(planLimitError({ key: "ai.doxa_agent" }))
    })
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(PRO_REASON_GENERATION)).toBeTruthy()
    // The viewer does not manage this account.
    expect(within(dialog).getByText(PRO_TRIAL_ASK_OWNER)).toBeTruthy()
    expect(within(dialog).queryByRole("button", { name: "Start 7-day Pro trial" })).toBeNull()
  })

  test("a Pro account at a Pro limit keeps Plan limit reached", async () => {
    billingApi.listBillingAccounts.mockResolvedValue({ enforcement: "on", accounts: [account("pro")] })
    renderDenialHost()
    act(() => {
      reportBillingDenial(
        planLimitError({
          key: "site.custom_domains",
          limit: 4,
          used: 4,
          plan: "pro",
          upgradeUrl: `https://doxa.test/dashboard/billing/${ACCOUNT_ID}`,
        }),
      )
    })
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Plan limit reached")).toBeTruthy()
    expect(screen.queryByText(PRO_TRIAL_TITLE)).toBeNull()
  })

  test("an unknown account keeps Plan limit reached", async () => {
    renderDenialHost()
    act(() => {
      reportBillingDenial(planLimitError({ plan: "free" }))
    })
    expect(within(await screen.findByRole("dialog")).getByText("Plan limit reached")).toBeTruthy()
  })

  test("402 credit dialogs stay as they are", async () => {
    renderDenialHost()
    act(() => {
      reportBillingDenial(
        createApiError(402, {
          error: {
            message: "No credits",
            details: {
              code: "credits_exhausted",
              accountId: ACCOUNT_ID,
              available: 0,
              needed: 300,
              reason: "trial_credits",
              resetsAt: null,
              billingUrl: null,
            },
          },
        }),
      )
    })
    expect(within(await screen.findByRole("dialog")).getByText("Trial credits are used up")).toBeTruthy()
    expect(screen.queryByText(PRO_TRIAL_TITLE)).toBeNull()
  })

  test("which refusals Pro unlocks, and their reasons", () => {
    expect(proTrialUnlocks("free", "ai.doxabot")).toBe(true)
    expect(proTrialUnlocks("free", "site.custom_domains")).toBe(true)
    expect(proTrialUnlocks("free", "agents.approval_rules")).toBe(false)
    expect(proTrialUnlocks("pro", "site.custom_domains")).toBe(false)
    expect(proTrialUnlocks(null, "ai.doxabot")).toBe(false)
    const domains: PlanLimitErrorDetails = {
      code: "plan_limit",
      key: "site.custom_domains",
      limit: 1,
      used: 1,
      plan: null,
      resetsAt: null,
      upgradeUrl: null,
    }
    expect(proTrialLimitReason(domains, "free")).toBe("You use 1 of 1 custom domains on Free. Pro has 4.")
    expect(proTrialLimitReason({ ...domains, key: "team.seats" }, "free")).toBe("You use 1 of 1 team seats on Free. Pro has no limit.")
    expect(planLimitProTrialRequest(domains, { accountId: null, plan: "free", canManage: true })).toBeNull()
    expect(accountIdFromBillingUrl(`https://doxa.test/dashboard/billing/${ACCOUNT_ID}`)).toBe(ACCOUNT_ID)
    expect(accountIdFromBillingUrl("https://doxa.test/pricing")).toBeNull()
  })

  test("a user who owns a Free team gets the Pro trial dialog for that team at the next team create", () => {
    const freeTeams: PlanLimitErrorDetails = {
      code: "plan_limit",
      key: FREE_TEAMS_PER_OWNER_KEY,
      limit: 1,
      used: 1,
      plan: "free",
      resetsAt: null,
      upgradeUrl: `https://doxa.test/dashboard/billing/${ACCOUNT_ID}`,
    }
    expect(proTrialUnlocks("free", FREE_TEAMS_PER_OWNER_KEY)).toBe(true)
    expect(proTrialUnlocks("pro", FREE_TEAMS_PER_OWNER_KEY)).toBe(false)
    expect(proTrialLimitReason(freeTeams, "free")).toBe(
      "Each person can own one Free team. Upgrade your Free team to Pro to create more teams.",
    )
    expect(planLimitSentence(freeTeams)).toBe(
      "Each person can own one Free team. Upgrade a Free team that you own to create more teams.",
    )
    // The teams page has no project or team in its route: the account comes from the billing link.
    const accountId = accountIdFromBillingUrl(freeTeams.upgradeUrl)
    expect(planLimitProTrialRequest(freeTeams, { accountId, plan: "free", canManage: true, name: "Acme Docs" })).toMatchObject({
      accountId: ACCOUNT_ID,
      feature: FREE_TEAMS_PER_OWNER_KEY,
      reason: 'Each person can own one Free team, and you own "Acme Docs". Upgrade "Acme Docs" to Pro to create more teams.',
    })
  })
})
