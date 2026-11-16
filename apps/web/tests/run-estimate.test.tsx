// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { ProjectGenerationCache } from "@doxahq/contracts"
import type { BillingAccountDetail, CreditEstimate } from "@doxahq/contracts/billing"

const billingApi = vi.hoisted(() => ({
  listBillingAccounts: vi.fn(),
  getBillingAccount: vi.fn(),
  getCreditEstimate: vi.fn(),
}))
vi.mock("~/lib/billing-api", async (importOriginal) => ({ ...(await importOriginal<object>()), ...billingApi }))
const platformApi = vi.hoisted(() => ({
  getProjectGenerationCache: vi.fn(),
  clearProjectGenerationCache: vi.fn(),
  getProjectDoxabotSettings: vi.fn(),
}))
vi.mock("~/lib/platform-api", async (importOriginal) => ({ ...(await importOriginal<object>()), ...platformApi }))

import { CreditEstimateLine } from "~/components/dashboard/billing/credit-estimate-line"
import { GenerationStartConfirmationContent } from "~/components/dashboard/generation-start-confirmation-dialog"
import { DoxabotSettingsCard } from "~/components/dashboard/project-doxabot-page"
import { Dialog, DialogContent } from "~/components/ui/dialog"
import {
  COLD_RUN_SENTENCE,
  defaultRunEstimate,
  isNextRunCold,
  pullRequestRunEstimate,
  trialCapNote,
} from "~/lib/dashboard/run-estimate"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"
import { ACTIVE_WITH_DEBT, FREE_ACCOUNT, TRIAL_ACCOUNT } from "./fixtures/billing"

const PROJECT_ID = "33333333-3333-4333-8333-333333333333"
const TRIAL_NOTE =
  "The trial has 640 credits, so the run stops there if it needs more. Finished pages stay on the draft branch, and you can continue it after you start Pro."

const WARM: ProjectGenerationCache = {
  siteId: "site-1",
  clearedAt: null,
  nextPullRequestRunCold: false,
  nextPullRequestRunAction: "doxabot.run",
  nextGenerationRunCold: false,
}
const COLD: ProjectGenerationCache = {
  ...WARM,
  nextPullRequestRunCold: true,
  nextPullRequestRunAction: "generation.run",
  nextGenerationRunCold: true,
}

function estimate(action: string, low: number, high: number, cap: number): CreditEstimate {
  return { action, low, high, cap, source: "history" }
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

/** A project of a billing account with enforcement on. */
function projectClient(accountId = TRIAL_ACCOUNT.id) {
  const client = newClient()
  client.setQueryData(dashboardQueryKeys.project(PROJECT_ID), {
    project: {},
    latestJob: null,
    role: "owner",
    billing: { accountId, plan: "pro", enforcement: "on" },
  })
  return client
}

function renderWith(children: ReactNode, client = newClient()) {
  render(<QueryClientProvider client={client}>{children}</QueryClientProvider>)
  return client
}

function useAccount(detail: BillingAccountDetail) {
  billingApi.listBillingAccounts.mockResolvedValue({
    enforcement: "on",
    accounts: [{ id: detail.id, ownerKind: "user", ownerId: "user-1", name: null, plan: detail.plan, canManage: true }],
  })
  billingApi.getBillingAccount.mockResolvedValue(detail)
}

beforeEach(() => {
  vi.clearAllMocks()
  useAccount(TRIAL_ACCOUNT)
  billingApi.getCreditEstimate.mockImplementation(async (_projectId: string, action: string) =>
    action === "generation.run" ? estimate(action, 300, 420, 3_000) : estimate(action, 40, 90, 500),
  )
  platformApi.getProjectGenerationCache.mockResolvedValue(WARM)
  platformApi.getProjectDoxabotSettings.mockRejectedValue(new Error("not under test"))
})
afterEach(cleanup)

describe("run estimate model", () => {
  test("a project that does not exist yet gets the default estimate with the account's cap", () => {
    expect(defaultRunEstimate("generation.run", TRIAL_ACCOUNT)).toEqual({
      action: "generation.run",
      low: 317,
      high: 450,
      cap: 3_000,
      source: "default",
    })
    const lowCap = { ...TRIAL_ACCOUNT, caps: TRIAL_ACCOUNT.caps.map((cap) => ({ ...cap, capCredits: 400 })) }
    expect(defaultRunEstimate("generation.run", lowCap)).toMatchObject({ low: 317, high: 400, cap: 400 })
    // Without the account detail, the catalog's default cap.
    expect(defaultRunEstimate("generation.run", null).cap).toBe(3_000)
  })

  test("the trial note shows only when the cap is above the trial credits left", () => {
    expect(trialCapNote(estimate("generation.run", 300, 420, 3_000), 640)).toBe(TRIAL_NOTE)
    expect(trialCapNote(estimate("generation.run", 300, 420, 640), 640)).toBeNull()
    expect(trialCapNote(estimate("generation.run", 300, 420, 3_000), null)).toBeNull()
  })

  test("a person's generation and a pull request run read their own temperature", () => {
    const mixed = { ...WARM, nextGenerationRunCold: true }
    expect(isNextRunCold(mixed, "generation.run")).toBe(true)
    expect(isNextRunCold(mixed, "doxabot.run")).toBe(false)
    expect(isNextRunCold(undefined, "generation.run")).toBeNull()
  })

  test("the Doxabot page bills the next pull request run as the cache says", () => {
    expect(pullRequestRunEstimate(WARM)).toEqual({ action: "doxabot.run", prefix: "Each run:" })
    expect(pullRequestRunEstimate(COLD)).toEqual({
      action: "generation.run",
      prefix: "Next pull request run starts cold: billed as a Full generation.",
    })
    expect(pullRequestRunEstimate(undefined)).toEqual({ action: "doxabot.run", prefix: "Each run:" })
  })
})

describe("the Generate dialog of a new project", () => {
  test("a cold Full generation with the cold sentence, the estimate line and the trial note", async () => {
    renderWith(<CreditEstimateLine projectId={null} action="generation.run" showRunType />)
    const panel = await screen.findByRole("region", { name: "AI credits" })
    expect(within(panel).getByText("Full generation")).toBeTruthy()
    expect(within(panel).getByText("Cold")).toBeTruthy()
    expect(within(panel).getByText(COLD_RUN_SENTENCE)).toBeTruthy()
    expect(within(panel).getByText("About 317–450 credits. Stops at 3,000.")).toBeTruthy()
    expect(within(panel).getByText(TRIAL_NOTE)).toBeTruthy()
    expect(within(panel).getByText("640")).toBeTruthy()
    expect(billingApi.getCreditEstimate).not.toHaveBeenCalled()
  })

  test("Pro (no trial): no trial note and no trial credits", async () => {
    useAccount(ACTIVE_WITH_DEBT)
    renderWith(<CreditEstimateLine projectId={null} action="generation.run" showRunType />)
    const panel = await screen.findByRole("region", { name: "AI credits" })
    expect(within(panel).getByText("Cold")).toBeTruthy()
    expect(within(panel).queryByText(/The trial has/)).toBeNull()
    expect(within(panel).queryByText(/Trial credits left/)).toBeNull()
  })

  test("billing off: nothing shows", async () => {
    billingApi.listBillingAccounts.mockResolvedValue({ enforcement: "off", accounts: [] })
    renderWith(<CreditEstimateLine projectId={null} action="generation.run" showRunType />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(screen.queryByRole("region", { name: "AI credits" })).toBeNull()
    expect(screen.queryByText("Full generation")).toBeNull()
  })
})

describe("the start confirmation of an existing project", () => {
  function renderConfirmation(client = projectClient()) {
    renderWith(
      <Dialog open>
        <DialogContent>
          <GenerationStartConfirmationContent
            reason="editor_content"
            message="Your site has pages."
            isPending={false}
            error={null}
            estimate={<CreditEstimateLine projectId={PROJECT_ID} action="generation.run" showRunType />}
            onCancel={() => undefined}
            onConfirm={() => undefined}
          />
        </DialogContent>
      </Dialog>,
      client,
    )
  }

  test("no cache: Full generation, COLD, the cold sentence and the estimate of the project", async () => {
    platformApi.getProjectGenerationCache.mockResolvedValue({ ...WARM, nextGenerationRunCold: true })
    renderConfirmation()
    const panel = await screen.findByRole("region", { name: "AI credits" })
    expect(within(panel).getByText("Full generation")).toBeTruthy()
    expect(within(panel).getByText("Cold")).toBeTruthy()
    expect(within(panel).getByText(COLD_RUN_SENTENCE)).toBeTruthy()
    expect(within(panel).getByText("About 300–420 credits. Stops at 3,000.")).toBeTruthy()
    expect(within(panel).getByText(TRIAL_NOTE)).toBeTruthy()
    expect(billingApi.getCreditEstimate).toHaveBeenCalledWith(PROJECT_ID, "generation.run")
  })

  test("with a cache: still a Full generation, with no COLD tag and no cold sentence", async () => {
    renderConfirmation()
    const panel = await screen.findByRole("region", { name: "AI credits" })
    expect(within(panel).getByText("Full generation")).toBeTruthy()
    expect(within(panel).queryByText("Cold")).toBeNull()
    expect(within(panel).queryByText(COLD_RUN_SENTENCE)).toBeNull()
  })

  test("a Free project of a trial-less account: no trial note", async () => {
    useAccount(FREE_ACCOUNT)
    renderConfirmation(projectClient(FREE_ACCOUNT.id))
    const panel = await screen.findByRole("region", { name: "AI credits" })
    expect(within(panel).queryByText(/The trial has/)).toBeNull()
  })
})

describe("estimates are hidden (2026-11-15: too volatile until there is data for the range)", () => {
  test("the Doxabot page shows no estimate and never asks for one", async () => {
    renderWith(<DoxabotSettingsCard projectId={PROJECT_ID} />, projectClient())
    expect(await screen.findByRole("heading", { name: "Pull request previews" })).toBeTruthy()
    expect(screen.queryByText(/credits\. Stops at/)).toBeNull()
    expect(screen.queryByText(/^Each run:/)).toBeNull()
    expect(billingApi.getCreditEstimate).not.toHaveBeenCalled()
  })
})
