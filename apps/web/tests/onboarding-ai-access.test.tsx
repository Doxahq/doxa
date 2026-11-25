// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { BillingAccountSummary } from "@doxahq/contracts/billing"

const billingApi = vi.hoisted(() => ({
  listBillingAccounts: vi.fn(),
  listBillingOffers: vi.fn(),
  createBillingCheckout: vi.fn(),
}))
vi.mock("~/lib/billing-api", async (importOriginal) => ({ ...(await importOriginal<object>()), ...billingApi }))

import { GenerationWelcome } from "~/components/dashboard/generation-welcome"
import { StartProjectCard } from "~/components/dashboard/new-project/start-project-card"
import { ApiRequestError } from "~/lib/api-errors"
import {
  AI_ACCESS_LOADING,
  AI_ACCESS_OPEN,
  newProjectAiAccess,
  planHasDoxaAgent,
  projectAiAccess,
  type AiGenerationAccess,
} from "~/lib/dashboard/ai-access"
import { useNewProjectAiAccess } from "~/lib/dashboard/use-ai-access"

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111"

function personal(plan: string): BillingAccountSummary {
  return { id: ACCOUNT_ID, ownerKind: "user", ownerId: "user-1", name: null, plan, canManage: true }
}

const TEAM_PRO: BillingAccountSummary = {
  id: "22222222-2222-4222-8222-222222222222",
  ownerKind: "team",
  ownerId: "team-1",
  name: "Acme",
  plan: "pro",
  canManage: true,
}

const FREE: AiGenerationAccess = { kind: "needs_pro", accountId: ACCOUNT_ID, canManage: true }

function withClient(children: ReactNode, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function renderCard(access: AiGenerationAccess) {
  const handlers = { onGenerateFromRepository: vi.fn(), onCreateProject: vi.fn() }
  render(withClient(<StartProjectCard isFirstProject access={access} {...handlers} />))
  return handlers
}

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(cleanup)

describe("Doxa Agent access", () => {
  test("only Free lacks the Doxa Agent; an unknown plan is left to the API", () => {
    expect(planHasDoxaAgent("free")).toBe(false)
    expect(planHasDoxaAgent("pro")).toBe(true)
    expect(planHasDoxaAgent("enterprise")).toBe(true)
    expect(planHasDoxaAgent("plan_from_the_future")).toBe(true)
  })

  test("new project: billing off (no accounts) keeps every option; Free needs Pro; trial and Pro are open", () => {
    const on = (accounts: BillingAccountSummary[]) => ({ enforcement: "on" as const, accounts })
    expect(newProjectAiAccess({ isPending: true, data: undefined }, null)).toEqual(AI_ACCESS_LOADING)
    // 503 billing_not_configured, or any other failure: today's onboarding.
    expect(newProjectAiAccess({ isPending: false, data: undefined }, null)).toEqual(AI_ACCESS_OPEN)
    expect(newProjectAiAccess({ isPending: false, data: on([]) }, null)).toEqual(AI_ACCESS_OPEN)
    // A Pro team does not help a personal project: it bills to the personal account.
    expect(newProjectAiAccess({ isPending: false, data: on([TEAM_PRO, personal("free")]) }, null)).toEqual(FREE)
    // A project of the Pro team bills to the team.
    expect(newProjectAiAccess({ isPending: false, data: on([TEAM_PRO, personal("free")]) }, "team-1")).toEqual(AI_ACCESS_OPEN)
    expect(newProjectAiAccess({ isPending: false, data: on([{ ...TEAM_PRO, plan: "free" }, personal("pro")]) }, "team-1")).toEqual({
      kind: "needs_pro",
      accountId: TEAM_PRO.id,
      canManage: true,
    })
    // A trial account's effective plan is Pro.
    expect(newProjectAiAccess({ isPending: false, data: on([personal("pro")]) }, null)).toEqual(AI_ACCESS_OPEN)
  })

  test("new project: enforcement off or shadow never gates, even with a payment provider and a Free plan", () => {
    for (const enforcement of ["off", "shadow"] as const) {
      expect(newProjectAiAccess({ isPending: false, data: { enforcement, accounts: [personal("free")] } }, null)).toEqual(AI_ACCESS_OPEN)
    }
  })

  test("existing project: `billing: null` keeps every option; a Free plan needs Pro only with enforcement on", () => {
    expect(projectAiAccess({ isPending: false, billing: null, canManageBilling: true })).toEqual(AI_ACCESS_OPEN)
    expect(projectAiAccess({ isPending: false, billing: undefined, canManageBilling: true })).toEqual(AI_ACCESS_OPEN)
    expect(
      projectAiAccess({ isPending: false, billing: { accountId: ACCOUNT_ID, plan: "pro", enforcement: "on" }, canManageBilling: true }),
    ).toEqual(AI_ACCESS_OPEN)
    expect(
      projectAiAccess({ isPending: false, billing: { accountId: ACCOUNT_ID, plan: "free", enforcement: "on" }, canManageBilling: false }),
    ).toEqual({
      kind: "needs_pro",
      accountId: ACCOUNT_ID,
      canManage: false,
    })
    for (const enforcement of ["off", "shadow"] as const) {
      expect(
        projectAiAccess({ isPending: false, billing: { accountId: ACCOUNT_ID, plan: "free", enforcement }, canManageBilling: true }),
      ).toEqual(AI_ACCESS_OPEN)
    }
  })

  test("the hook reads 503 billing_not_configured as open", async () => {
    billingApi.listBillingAccounts.mockRejectedValue(new ApiRequestError("Billing is not configured", 503, "billing_not_configured"))
    function Probe() {
      return <span>{useNewProjectAiAccess({ teamId: null }).kind}</span>
    }
    render(withClient(<Probe />))
    expect(screen.getByText("loading")).toBeTruthy()
    await waitFor(() => expect(screen.getByText("open")).toBeTruthy())
  })

  // The workspace menu enables the same query once the page settles. A failed
  // read has no data, so its new fetch is `pending` again: the card must not
  // turn back into its skeleton.
  test("the hook stays open while a failed read runs again", async () => {
    billingApi.listBillingAccounts.mockRejectedValue(new ApiRequestError("Billing is not configured", 503, "billing_not_configured"))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const seen: string[] = []
    function Probe() {
      const kind = useNewProjectAiAccess({ teamId: null }).kind
      seen.push(kind)
      return <span>{kind}</span>
    }
    render(withClient(<Probe />, client))
    await waitFor(() => expect(screen.getByText("open")).toBeTruthy())
    seen.length = 0
    let finishRefetch: () => void = () => {}
    billingApi.listBillingAccounts.mockImplementation(
      () => new Promise((_, reject) => (finishRefetch = () => reject(new ApiRequestError("Billing is not configured", 503, "billing_not_configured")))),
    )
    const refetch = client.refetchQueries({ queryKey: ["billing"] })
    await waitFor(() => expect(client.isFetching()).toBeGreaterThan(0))
    finishRefetch()
    await refetch
    expect(screen.getByText("open")).toBeTruthy()
    expect(seen).not.toContain("loading")
  })
})

describe("onboarding start card", () => {
  test("billing inactive, trial or Pro: today's card, generation first", async () => {
    const handlers = renderCard(AI_ACCESS_OPEN)
    await userEvent.click(screen.getByRole("button", { name: "Generate from a repository" }))
    await userEvent.click(screen.getByRole("button", { name: "Create project" }))
    expect(handlers.onGenerateFromRepository).toHaveBeenCalledOnce()
    expect(handlers.onCreateProject).toHaveBeenCalledOnce()
    expect(screen.queryByText("You can rename or delete the project later.")).toBeNull()
    expect(screen.queryByText("Pro")).toBeNull()
    expect(screen.queryByRole("button", { name: /Pro trial/ })).toBeNull()
  })

  test("Free: the same buttons in the same order; the note says the generation needs Pro, and no trial shows", async () => {
    const handlers = renderCard(FREE)

    const generate = screen.getByRole("button", { name: "Generate from a repository" })
    const create = screen.getByRole("button", { name: "Create project" })
    expect(generate.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(generate.className).toContain("bg-foreground")
    // A PRO tag on the button, kept out of its name; the reason is the dialog's alone.
    expect(within(generate).getByText("Pro").getAttribute("aria-hidden")).toBe("true")
    expect(screen.queryByText("You can rename or delete the project later.")).toBeNull()
    expect(screen.queryByText(/needs Pro/)).toBeNull()
    expect(screen.getByText(/Have code on GitHub\? Doxabot reads your repository/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Pro trial/ })).toBeNull()

    // The card only reports the click; the page decides that it opens the Pro trial dialog.
    await userEvent.click(generate)
    expect(handlers.onGenerateFromRepository).toHaveBeenCalledOnce()
    await userEvent.click(create)
    expect(handlers.onCreateProject).toHaveBeenCalledOnce()
    expect(billingApi.listBillingOffers).not.toHaveBeenCalled()
    expect(billingApi.createBillingCheckout).not.toHaveBeenCalled()
  })

  test("loading: no button until the plan is known, so nothing swaps", () => {
    renderCard(AI_ACCESS_LOADING)
    expect(screen.queryAllByRole("button")).toHaveLength(0)
  })
})

describe("generation welcome", () => {
  test("always the normal Generate docs button; the start flow decides about Pro", async () => {
    const onStart = vi.fn()
    render(withClient(<GenerationWelcome isStarting={false} isGenerating={false} onStart={onStart} />))
    await userEvent.click(screen.getByRole("button", { name: "Generate docs" }))
    expect(onStart).toHaveBeenCalledOnce()
    expect(screen.queryByRole("button", { name: /Pro trial/ })).toBeNull()
  })
})
