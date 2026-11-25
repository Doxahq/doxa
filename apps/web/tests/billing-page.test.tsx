// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { BillingAccountDetail, BillingInvoice } from "@doxahq/contracts/billing"

// The top bar needs the dashboard shell (sidebar); the page body does not.
vi.mock("~/components/dashboard/shell/top-bar", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  AccountTopBar: () => null,
}))

import { BillingAccountView, type BillingViewActions } from "~/components/dashboard/billing/billing-account-view"
import { BillingCreditsView, type CreditsViewActions } from "~/components/dashboard/billing/billing-credits-view"
import { CreditEstimateLine } from "~/components/dashboard/billing/credit-estimate-line"
import { PAYG_CHARGE_SENTENCE, creditHistoryRows } from "~/lib/dashboard/billing-model"
import { billingQueryKeys } from "~/lib/queries/billing"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"
import {
  ACTIVE_WITH_DEBT,
  CANCELED_TRIAL_ACCOUNT,
  CHARGE_IN_PROGRESS,
  ENDED_TRIAL_ACCOUNT,
  FREE_ACCOUNT,
  INVOICES,
  LEDGER_ENTRIES,
  MANY_INVOICES,
  PAST_DUE_ACCOUNT,
  TRIAL_ACCOUNT,
} from "./fixtures/billing"
import { newQueryClient, renderInRouter } from "./fixtures/render-in-router"

afterEach(cleanup)

const NO_MORE = { hasMore: false, isLoadingMore: false, onLoadMore: () => undefined }

function planActions(): BillingViewActions {
  return {
    plan: {
      onCancel: vi.fn(),
      onManage: vi.fn(),
      isPortalPending: false,
      portalError: null,
      onSwitchInterval: vi.fn(async () => undefined),
      isSwitchPending: false,
      switchError: null,
    },
    upgrade: { onUpgrade: vi.fn(), isPending: false, error: null },
    updateCard: { onUpdateCard: vi.fn(), isPending: false, error: null },
  }
}

function creditsActions(): CreditsViewActions {
  return {
    payg: { onChange: vi.fn(async () => undefined), isPending: false, error: null },
    caps: { onSave: vi.fn(async () => undefined), isPending: false, error: null },
  }
}

async function renderPlan(detail: BillingAccountDetail, invoices: BillingInvoice[] = INVOICES) {
  const handlers = planActions()
  renderInRouter(
    <BillingAccountView detail={detail} invoices={invoices} invoicePages={NO_MORE} actions={handlers} />,
  )
  await screen.findByRole("heading", { name: "Plan and invoices" })
  return handlers
}

async function renderCredits(detail: BillingAccountDetail, invoices: BillingInvoice[] = INVOICES) {
  const handlers = creditsActions()
  renderInRouter(
    <BillingCreditsView
      detail={detail}
     
      invoices={invoices}
      historyRows={creditHistoryRows(LEDGER_ENTRIES)}
      historyPages={NO_MORE}
      actions={handlers}
    />,
  )
  await screen.findByRole("heading", { name: "AI credits" })
  return handlers
}

function section(name: RegExp | string): HTMLElement {
  return screen.getByRole("heading", { name }).closest("section") as HTMLElement
}

describe("Plan and invoices", () => {
  test("Free: the plan, the Upgrade card with both feature groups, yearly founder price by default, and the plan limits", async () => {
    const handlers = await renderPlan(FREE_ACCOUNT, [])
    const plan = section("Plan")
    expect(within(plan).getByText("No subscription")).toBeTruthy()
    expect(within(plan).getByText(/Hosting, the editor, 1 custom domain and MCP\./)).toBeTruthy()

    const upgrade = section("Upgrade to Pro")
    expect(within(upgrade).getByText("$99")).toBeTruthy()
    expect(within(upgrade).getByText(/Billed yearly at \$1,188/)).toBeTruthy()
    expect(within(upgrade).getByText(/37 of 50 founder spots left/)).toBeTruthy()
    expect(within(upgrade).getByText("AI")).toBeTruthy()
    expect(within(upgrade).getByText("Site and team")).toBeTruthy()
    expect(within(upgrade).getByText("Docs written from your repo")).toBeTruthy()
    expect(within(upgrade).getByRole("radio", { name: /Yearly/ }).getAttribute("aria-checked")).toBe("true")
    await userEvent.click(within(upgrade).getByRole("button", { name: "Start 7-day Pro trial" }))
    expect(handlers.upgrade.onUpgrade).toHaveBeenCalledWith("pro_yearly_founder_v2")
    await userEvent.click(within(upgrade).getByRole("radio", { name: /Monthly/ }))
    expect(within(upgrade).getByText("$129")).toBeTruthy()
    await userEvent.click(within(upgrade).getByRole("button", { name: "Start 7-day Pro trial" }))
    expect(handlers.upgrade.onUpgrade).toHaveBeenLastCalledWith("pro_monthly_founder_v2")

    // The limits come from the entitlements; the API sends no use, so there are no bars.
    const limits = section("Plan limits")
    expect(within(limits).getByText("Custom domains")).toBeTruthy()
    expect(within(limits).queryByRole("meter")).toBeNull()

    expect(screen.queryByRole("heading", { name: "Payment method" })).toBeNull()
    expect(screen.queryByRole("link", { name: /AI credits/ })).toBeNull()
    expect(screen.queryByRole("heading", { name: "Invoices" })).toBeNull()
  })

  test("ended trial: Free with one line of history, and an upgrade that says Stripe charges today", async () => {
    await renderPlan(ENDED_TRIAL_ACCOUNT, [])
    const plan = section("Plan")
    expect(within(plan).getByText("Free")).toBeTruthy()
    expect(within(plan).getByText("No subscription")).toBeTruthy()
    expect(within(plan).getByText("Your Pro trial ended on Nov 17, 2026.")).toBeTruthy()
    expect(within(plan).queryByText("Canceled")).toBeNull()
    expect(within(plan).queryByText("Founder price")).toBeNull()
    expect(within(plan).queryByText(/Ends on/)).toBeNull()

    const upgrade = section("Upgrade to Pro")
    expect(within(upgrade).getByRole("button", { name: "Upgrade to Pro" })).toBeTruthy()
    expect(within(upgrade).getByText("This account already had a trial, so Stripe charges the first payment today.")).toBeTruthy()
    expect(within(upgrade).queryByText(/trial with/)).toBeNull()
    // The ended trial left a subscription on record, but Free has nothing to pay with or for.
    expect(screen.queryByRole("heading", { name: "Payment method" })).toBeNull()
    expect(screen.queryByRole("heading", { name: "Invoices" })).toBeNull()
  })

  test("canceled Pro, now Free: its past invoices stay, without a payment method", async () => {
    await renderPlan(ENDED_TRIAL_ACCOUNT, INVOICES)

    expect(within(section("Invoices")).getByRole("table", { name: "Invoices" })).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "Payment method" })).toBeNull()
  })

  test("trial: the trial end, the charge after it, Start Pro now, the switch and Cancel trial", async () => {
    const handlers = await renderPlan(TRIAL_ACCOUNT, [])
    const plan = section("Plan")
    expect(within(plan).getByText("Trial")).toBeTruthy()
    expect(within(plan).getByText("Founder price")).toBeTruthy()
    expect(within(plan).getByText("Trial ends on Nov 17, 2026")).toBeTruthy()
    expect(within(plan).getByText("Then $1,188 for the year at the founder price, charged on Nov 17, 2026.")).toBeTruthy()
    expect(within(plan).getByText("Cancel before Nov 17, 2026 and you pay nothing. Your docs stay online on Free.")).toBeTruthy()
    expect(within(plan).getByRole("button", { name: "Start Pro now" })).toBeTruthy()
    expect(within(plan).getByRole("button", { name: "Switch to monthly" })).toBeTruthy()
    await userEvent.click(within(plan).getByRole("button", { name: "Cancel trial" }))
    expect(handlers.plan.onCancel).toHaveBeenCalledOnce()

    const credits = screen.getByRole("link", { name: /AI credits/ })
    expect(credits.getAttribute("href")).toBe(`/dashboard/billing/${TRIAL_ACCOUNT.id}/credits`)
    expect(within(credits).getByText("640 of 1,000 trial credits left · pay-as-you-go starts when the trial ends")).toBeTruthy()
    expect(within(section("Invoices")).getByText("No invoices yet. The first one comes when the trial ends.")).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "Upgrade to Pro" })).toBeNull()
  })

  test("Pro: price and renewal, the founder note, Cancel plan, the AI credits row and the invoice table", async () => {
    const handlers = await renderPlan(ACTIVE_WITH_DEBT)
    const plan = section("Plan")
    expect(within(plan).getByText("Active")).toBeTruthy()
    expect(within(plan).getByText("$1,188 / year · Renews on Nov 14, 2027")).toBeTruthy()
    expect(within(plan).getByText("The founder price stays while the plan stays active.")).toBeTruthy()
    expect(within(plan).queryByRole("button", { name: "Start Pro now" })).toBeNull()
    await userEvent.click(within(plan).getByRole("button", { name: "Cancel plan" }))
    expect(handlers.plan.onCancel).toHaveBeenCalledOnce()

    expect(screen.getByText("0 of 5,000 monthly credits left · pay-as-you-go on, $14.20 of $30 used this month")).toBeTruthy()

    const invoices = section("Invoices")
    expect(within(invoices).getByText("Prices do not include tax. Stripe adds your country's tax to each invoice.")).toBeTruthy()
    const table = within(invoices).getByRole("table", { name: "Invoices" })
    // The open invoice has a Pay link; the paid ones a PDF.
    expect(within(table).getByRole("link", { name: "Pay this invoice" }).getAttribute("href")).toBe("https://invoice.test/in_3")
    expect(within(table).getAllByRole("link", { name: "Download" })).toHaveLength(2)
    expect(within(table).getAllByText("Pay-as-you-go · 500 credits")).toHaveLength(2)
    expect(within(table).getByText("Doxa Pro")).toBeTruthy()
  })

  test("invoices: five rows first, then Show older invoices", async () => {
    await renderPlan(ACTIVE_WITH_DEBT, MANY_INVOICES)
    const invoices = section("Invoices")
    expect(within(invoices).getAllByRole("row")).toHaveLength(1 + 5)
    expect(within(invoices).getByText("Showing 5 invoices")).toBeTruthy()
    await userEvent.click(within(invoices).getByRole("button", { name: "Show older invoices" }))
    expect(within(invoices).getAllByRole("row")).toHaveLength(1 + 7)
    expect(within(invoices).queryByRole("button", { name: "Show older invoices" })).toBeNull()
  })

  test("payment method: the card and its expiry, Update in Stripe, and the null case", async () => {
    const handlers = await renderPlan(ACTIVE_WITH_DEBT)
    const card = section("Payment method")
    expect(within(card).getByText("Visa ending 4242")).toBeTruthy()
    expect(within(card).getByText("Expires 08/2029 · Stripe charges this card for the plan and for pay-as-you-go")).toBeTruthy()
    await userEvent.click(within(card).getByRole("button", { name: "Update in Stripe" }))
    expect(handlers.updateCard.onUpdateCard).toHaveBeenCalledOnce()
    cleanup()

    await renderPlan(TRIAL_ACCOUNT, [])
    expect(within(section("Payment method")).getByText("Expires 08/2029 · first charge on Nov 17, 2026")).toBeTruthy()
    cleanup()

    const noCard = await renderPlan({ ...ACTIVE_WITH_DEBT, paymentMethod: null })
    const managed = section("Payment method")
    expect(within(managed).getByText("Managed in Stripe")).toBeTruthy()
    expect(within(managed).queryByText(/ending/)).toBeNull()
    await userEvent.click(within(managed).getByRole("button", { name: "Update in Stripe" }))
    expect(noCard.updateCard.onUpdateCard).toHaveBeenCalledOnce()
  })

  test("past due: the banner opens the card update, and the card shows the failed charge", async () => {
    const handlers = await renderPlan(PAST_DUE_ACCOUNT)
    expect(screen.getByText("Past due")).toBeTruthy()
    const banner = screen.getAllByRole("alert")[0] as HTMLElement
    expect(within(banner).getByText("A payment failed")).toBeTruthy()
    await userEvent.click(within(banner).getByRole("button", { name: "Update the card" }))
    expect(handlers.updateCard.onUpdateCard).toHaveBeenCalledOnce()
    expect(within(section("Plan")).getByText("The last payment failed. Update your card to keep Pro.")).toBeTruthy()
    expect(within(section("Payment method")).getByText("Expires 08/2029 · the last charge failed")).toBeTruthy()
    expect(screen.getByText(/pay-as-you-go paused until the invoice is paid/)).toBeTruthy()
  })

  test("a viewer who cannot manage sees values, not controls", async () => {
    await renderPlan({ ...ACTIVE_WITH_DEBT, canManage: false })
    expect(screen.queryByRole("button", { name: /Switch to|Cancel plan|Update in Stripe/ })).toBeNull()
  })

  test("has no account picker: the logo menu picks the workspace, and so the account", async () => {
    await renderPlan(ACTIVE_WITH_DEBT)
    expect(screen.queryByRole("button", { name: /Personal account|Choose an account/ })).toBeNull()
  })
})

describe("AI credits", () => {
  test("this month: the meter, from the monthly credits, from pay-as-you-go, and the reset", async () => {
    await renderCredits(ACTIVE_WITH_DEBT)
    const month = section("This month")
    expect(within(month).getByText("Monthly AI credits")).toBeTruthy()
    expect(within(month).getByText("0 of 5,000 left")).toBeTruthy()
    expect(within(month).getByText("5,000 credits")).toBeTruthy()
    expect(within(month).getByText("1,420 credits · $14.20")).toBeTruthy()
    expect(within(month).getByText("Dec 14, 2026")).toBeTruthy()
    expect(within(month).getByText(/120 credits are held for runs in progress/)).toBeTruthy()
  })

  test("trial: the trial credits, and pay-as-you-go waits for the trial", async () => {
    await renderCredits(TRIAL_ACCOUNT, [])
    const month = section("This month")
    expect(within(month).getByText("Trial credits")).toBeTruthy()
    expect(within(month).getByText("640 of 1,000 left")).toBeTruthy()
    expect(within(month).getByText("Trial ends on")).toBeTruthy()
    expect(screen.getByText(/Pay-as-you-go starts when the trial ends\. During the trial/)).toBeTruthy()
    expect(screen.queryByRole("switch", { name: "Pay-as-you-go" })).toBeNull()
    expect(screen.queryByRole("button", { name: /pay now/i })).toBeNull()
  })

  test("canceled trial: the trial end says it will not renew, and nothing promises pay-as-you-go", async () => {
    await renderCredits(CANCELED_TRIAL_ACCOUNT, [])
    const month = section("This month")
    expect(within(month).getByText("Nov 17, 2026 · will not renew")).toBeTruthy()
    expect(within(month).getByText("None, the plan ends with the trial")).toBeTruthy()
    expect(screen.getByText(/The trial will not renew, so pay-as-you-go does not start/)).toBeTruthy()
    expect(screen.queryByText(/starts when the trial ends/i)).toBeNull()
  })

  test("Free: no credits, a link to Plan and invoices, and no caps", async () => {
    await renderCredits(FREE_ACCOUNT, [])
    expect(screen.getByText("No AI credits on this plan")).toBeTruthy()
    expect(screen.getByRole("link", { name: "Plan and invoices" }).getAttribute("href")).toBe(`/dashboard/billing/${FREE_ACCOUNT.id}`)
    expect(screen.queryByRole("heading", { name: "Cap per run" })).toBeNull()
    expect(screen.queryByRole("heading", { name: "Pay-as-you-go" })).toBeNull()
  })

  test("pay-as-you-go: the balance, the automatic charge sentence, the month against the limit, past charges", async () => {
    const handlers = await renderCredits(ACTIVE_WITH_DEBT)
    const payg = section("Pay-as-you-go")
    expect(within(payg).getByText(PAYG_CHARGE_SENTENCE, { exact: false })).toBeTruthy()
    expect(PAYG_CHARGE_SENTENCE).toBe("Doxa charges your card automatically when your balance reaches $5, and once a month.")
    expect(within(payg).getByText("$3.20")).toBeTruthy()
    expect(within(payg).getByText("$14.20")).toBeTruthy()
    expect(within(payg).getByText(/of \$30 monthly limit/)).toBeTruthy()
    expect(within(payg).getByText("Next monthly charge: Dec 20, 2026")).toBeTruthy()
    expect(within(payg).queryByText("Charge in progress")).toBeNull()
    expect(within(payg).getByRole("link", { name: /Invoice/ }).getAttribute("href")).toBe("https://invoice.test/in_2")

    const limit = within(payg).getByRole("textbox", { name: "Monthly limit in dollars" })
    await userEvent.clear(limit)
    await userEvent.type(limit, "250")
    await userEvent.click(within(payg).getByRole("button", { name: "Save" }))
    expect(within(payg).getByText("Enter a whole amount from $5 to $200.")).toBeTruthy()
    expect(handlers.payg.onChange).not.toHaveBeenCalled()
    await userEvent.clear(limit)
    await userEvent.type(limit, "60")
    await userEvent.click(within(payg).getByRole("button", { name: "Save" }))
    expect(handlers.payg.onChange).toHaveBeenCalledWith({ monthlyLimitCents: 6_000 })

    await userEvent.click(within(payg).getByRole("switch", { name: "Pay-as-you-go" }))
    expect(handlers.payg.onChange).toHaveBeenLastCalledWith({ enabled: false })
  })

  test("charge in progress exactly while the API reports an open threshold invoice", async () => {
    await renderCredits(CHARGE_IN_PROGRESS)
    expect(within(section("Pay-as-you-go")).getByText("Charge in progress")).toBeTruthy()
    cleanup()
    await renderCredits({ ...ACTIVE_WITH_DEBT, payg: { ...ACTIVE_WITH_DEBT.payg, debtInPayment: 500, thresholdInvoiceOpen: false } })
    expect(within(section("Pay-as-you-go")).queryByText("Charge in progress")).toBeNull()
  })

  test("past due: the failed charge has a Pay invoice link", async () => {
    await renderCredits(PAST_DUE_ACCOUNT)
    const payg = section("Pay-as-you-go")
    expect(within(payg).getByRole("link", { name: /Pay invoice/ }).getAttribute("href")).toBe("https://invoice.test/in_3")
  })

  test("the cap rows name each action with its COLD or WARM tag", async () => {
    await renderCredits(ACTIVE_WITH_DEBT)
    const caps = section("Cap per run")
    expect(within(caps).getByText("A run stops when it reaches its cap. Continue the run to finish it and keep its pages.")).toBeTruthy()
    const [full, update] = within(caps).getAllByRole("listitem") as [HTMLElement, HTMLElement]
    expect(within(full).getByText("Full generation")).toBeTruthy()
    expect(within(full).getByText("COLD")).toBeTruthy()
    expect(within(full).getByText("Base fee 50 credits. Lowest cap 1,000 credits.")).toBeTruthy()
    expect(within(full).queryByText(/at most|Default/)).toBeNull()
    expect(within(update).getByText("Update run")).toBeTruthy()
    expect(within(update).getByText("WARM")).toBeTruthy()
    expect(within(update).getByText("Base fee 20 credits. Lowest cap 500 credits.")).toBeTruthy()
  })

  test("a cap outside the range swaps the note for a red error, linked to the field", async () => {
    await renderCredits(ACTIVE_WITH_DEBT)
    const [, update] = within(section("Cap per run")).getAllByRole("listitem") as [HTMLElement, HTMLElement]
    const field = within(update).getByRole("textbox", { name: "Update run" })
    await userEvent.clear(field)
    await userEvent.type(field, "10001")
    await userEvent.click(within(update).getByRole("button", { name: "Save" }))
    const alert = within(update).getByRole("alert")
    expect(alert.textContent).toBe("The highest cap is 10,000 credits.")
    expect(alert.className).toContain("text-destructive")
    expect(field.getAttribute("aria-describedby")).toBe(alert.id)
    // The error takes the note's place, so the row does not move.
    expect(within(update).queryByText("Base fee 20 credits. Lowest cap 500 credits.")).toBeNull()

    // A new value brings the note back.
    await userEvent.clear(field)
    expect(within(update).queryByRole("alert")).toBeNull()
    expect(within(update).getByText("Base fee 20 credits. Lowest cap 500 credits.").id).toBe(alert.id)

    // Above the base fee, below the lowest cap.
    await userEvent.type(field, "60")
    await userEvent.click(within(update).getByRole("button", { name: "Save" }))
    expect(within(update).getByRole("alert").textContent).toBe("The lowest cap is 500 credits.")
  })

  test("credit history: one row per run, and the All / Runs / Added and charged filter", async () => {
    await renderCredits(ACTIVE_WITH_DEBT)
    const history = section("Credit history")
    const table = () => within(history).getByRole("table", { name: "Credit history" })
    // The generation's debit and debt add up: 60 from the grants, 240 from pay-as-you-go.
    expect(within(table()).getByText(/Full generation · 60 monthly, 240 pay-as-you-go/)).toBeTruthy()
    expect(within(table()).getByText("−300")).toBeTruthy()
    expect(within(table()).getByText("+5,000")).toBeTruthy()
    expect(within(table()).getAllByRole("row")).toHaveLength(1 + 3)

    await userEvent.click(within(history).getByRole("radio", { name: "Runs" }))
    expect(within(table()).getAllByRole("row")).toHaveLength(1 + 2)
    expect(within(table()).queryByText("+5,000")).toBeNull()

    await userEvent.click(within(history).getByRole("radio", { name: "Added and charged" }))
    expect(within(table()).getAllByRole("row")).toHaveLength(1 + 1)
    expect(within(table()).getByText("Credits added")).toBeTruthy()

    await userEvent.click(within(history).getByRole("radio", { name: "All" }))
    expect(within(table()).getAllByRole("row")).toHaveLength(1 + 3)
  })
})

describe("the estimate line", () => {
  test("draws nothing while the project's billing is null", () => {
    const queryClient = newQueryClient()
    queryClient.setQueryData(dashboardQueryKeys.project("p1"), { project: {}, latestJob: null, role: "owner", billing: null })
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const { container } = renderInRouter(<CreditEstimateLine projectId="p1" action="generation.run" />, { client: queryClient })
    expect(container.textContent).toBe("")
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  test("shows the range, the cap and the pay-as-you-go part", async () => {
    const queryClient = newQueryClient()
    queryClient.setQueryData(dashboardQueryKeys.project("p1"), {
      project: {},
      latestJob: null,
      role: "owner",
      billing: { accountId: ACTIVE_WITH_DEBT.id, plan: "pro", enforcement: "on" },
    })
    queryClient.setQueryData(billingQueryKeys.estimate("p1", "generation.run"), { action: "generation.run", low: 220, high: 300, cap: 3_000, source: "history" })
    queryClient.setQueryData(billingQueryKeys.detail(ACTIVE_WITH_DEBT.id), { ...ACTIVE_WITH_DEBT, credits: { ...ACTIVE_WITH_DEBT.credits, granted: 60 } })
    renderInRouter(<CreditEstimateLine projectId="p1" action="generation.run" />, { client: queryClient })
    expect(await screen.findByText(/About 220–300 credits\. Stops at 3,000\./)).toBeTruthy()
    expect(screen.getByText(/About \$2\.40 from pay-as-you-go/)).toBeTruthy()
  })

  test.each(["off", "shadow"] as const)("draws nothing with enforcement %s", async (enforcement) => {
    const queryClient = newQueryClient()
    queryClient.setQueryData(dashboardQueryKeys.project("p1"), {
      project: {},
      latestJob: null,
      role: "owner",
      billing: { accountId: ACTIVE_WITH_DEBT.id, plan: "free", enforcement },
    })
    queryClient.setQueryData(billingQueryKeys.estimate("p1", "generation.run"), { action: "generation.run", low: 220, high: 300, cap: 3_000, source: "history" })
    const { container, router } = renderInRouter(<CreditEstimateLine projectId="p1" action="generation.run" />, { client: queryClient })
    await router.load()
    expect(container.textContent).toBe("")
  })
})
