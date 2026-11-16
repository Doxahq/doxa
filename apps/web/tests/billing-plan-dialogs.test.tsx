// @vitest-environment jsdom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const billingApi = vi.hoisted(() => ({
  getStartProNowPreview: vi.fn(),
  getPlanIntervalPreview: vi.fn(),
  startProNow: vi.fn(),
  createBillingPortal: vi.fn(),
}))
vi.mock("~/lib/billing-api", async (importOriginal) => ({ ...(await importOriginal<object>()), ...billingApi }))

import { BillingDenialDialogHost } from "~/components/dashboard/billing/billing-denial-dialog"
import { BillingIntervalSwitchDialog } from "~/components/dashboard/billing/billing-interval-switch-dialog"
import { StartProNowDialog } from "~/components/dashboard/billing/start-pro-now-dialog"
import { createApiError } from "~/lib/api-errors"
import { reportBillingDenial, showBillingDenial } from "~/lib/dashboard/billing-denials"
import { switchTargetPrice, type SwitchTarget } from "~/lib/dashboard/billing-model"
import { billingQueryKeys } from "~/lib/queries/billing"
import { ACTIVE_WITH_DEBT, START_PRO_NOW_PREVIEW, TRIAL_ACCOUNT, YEAR_TO_MONTH_PREVIEW } from "./fixtures/billing"
import { renderInRouter } from "./fixtures/render-in-router"

const ACCOUNT_ID = TRIAL_ACCOUNT.id

beforeEach(() => {
  vi.clearAllMocks()
  // The Portal opens with a page load; the test only checks that it was asked for.
  billingApi.createBillingPortal.mockReturnValue(new Promise(() => undefined))
})
afterEach(() => {
  cleanup()
  showBillingDenial(null)
})

function renderStartProNow() {
  const onOpenChange = vi.fn()
  const view = renderInRouter(<StartProNowDialog accountId={ACCOUNT_ID} open onOpenChange={onOpenChange} />)
  return { ...view, onOpenChange }
}

describe("Start Pro now (decision D22)", () => {
  test("shows the charge from the preview, starts Pro and writes the account into the cache", async () => {
    billingApi.getStartProNowPreview.mockResolvedValue(START_PRO_NOW_PREVIEW)
    const started = { ...ACTIVE_WITH_DEBT, id: ACCOUNT_ID }
    billingApi.startProNow.mockResolvedValue(started)
    const { client, onOpenChange } = renderStartProNow()

    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("heading", { name: "Start Pro now?" })).toBeTruthy()
    expect(
      await within(dialog).findByText("Ends your trial today. Stripe charges $1,548 for the year now. You get 5,000 AI credits each month."),
    ).toBeTruthy()
    await userEvent.click(within(dialog).getByRole("button", { name: "Start Pro now" }))

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(billingApi.startProNow).toHaveBeenCalledWith(ACCOUNT_ID)
    expect(client.getQueryData(billingQueryKeys.detail(ACCOUNT_ID))).toEqual(started)
  })

  test("without a preview it still says what happens, without an amount", async () => {
    billingApi.getStartProNowPreview.mockRejectedValue(createApiError(503, { error: { message: "Down", details: { code: "provider_unavailable" } } }))
    renderStartProNow()
    expect(
      await screen.findByText("Ends your trial today. Stripe charges the plan price now. You get 5,000 AI credits each month."),
    ).toBeTruthy()
  })

  test("402 payment_failed: the card error and Update in Stripe; nothing changes", async () => {
    billingApi.getStartProNowPreview.mockResolvedValue(START_PRO_NOW_PREVIEW)
    billingApi.startProNow.mockRejectedValue(
      createApiError(402, {
        error: { message: "The card was declined. Update the payment method and try again.", details: { code: "payment_failed" } },
      }),
    )
    const { onOpenChange } = renderStartProNow()
    const dialog = await screen.findByRole("dialog")
    await within(dialog).findByText(/Stripe charges \$1,548/)
    await userEvent.click(within(dialog).getByRole("button", { name: "Start Pro now" }))

    expect(await within(dialog).findByText("The card was declined. Update the payment method and try again.")).toBeTruthy()
    expect(onOpenChange).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole("button", { name: "Update in Stripe" }))
    expect(billingApi.createBillingPortal).toHaveBeenCalledWith(ACCOUNT_ID, "payment_method_update")
    // A retry stays possible after the card update.
    expect(within(dialog).getByRole("button", { name: "Start Pro now" })).toBeTruthy()
  })

  test("409: the trial already ended; the dialog says so and offers no retry", async () => {
    billingApi.getStartProNowPreview.mockResolvedValue(START_PRO_NOW_PREVIEW)
    billingApi.startProNow.mockRejectedValue(
      createApiError(409, { error: { message: "The subscription is not in its trial.", details: { code: "not_trialing" } } }),
    )
    renderStartProNow()
    const dialog = await screen.findByRole("dialog")
    await within(dialog).findByText(/Stripe charges \$1,548/)
    await userEvent.click(within(dialog).getByRole("button", { name: "Start Pro now" }))

    expect(await within(dialog).findByText(/The trial already ended, so there is nothing to start/)).toBeTruthy()
    expect(within(dialog).queryByRole("button", { name: "Start Pro now" })).toBeNull()
    expect(within(dialog).queryByRole("button", { name: "Update in Stripe" })).toBeNull()
  })
})

function founderMonthlyTarget(): SwitchTarget {
  const target = switchTargetPrice("pro_yearly_founder_v1")
  if (!target) throw new Error("The founder yearly price has no monthly sibling.")
  return target
}

describe("the monthly/yearly switch dialog", () => {
  const target = founderMonthlyTarget()

  function renderSwitch() {
    const onConfirm = vi.fn(async () => undefined)
    const onOpenChange = vi.fn()
    renderInRouter(
      <BillingIntervalSwitchDialog
        accountId={ACCOUNT_ID}
        target={target}
        isFounder
        open
        onOpenChange={onOpenChange}
        isPending={false}
        error={null}
        onConfirm={onConfirm}
      />,
    )
    return { onConfirm, onOpenChange }
  }

  test("the preview rows: the credit to the balance, the first month, the charge today, and the note", async () => {
    let answer: (preview: typeof YEAR_TO_MONTH_PREVIEW) => void = () => undefined
    billingApi.getPlanIntervalPreview.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const { onConfirm, onOpenChange } = renderSwitch()
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("heading", { name: "Switch to monthly?" })).toBeTruthy()
    expect(within(dialog).getByText("Your plan changes today to $159 a month. You keep the founder price.")).toBeTruthy()
    // A loading state shaped like the rows, then the rows.
    expect(within(dialog).getByText("Loading the amounts")).toBeTruthy()
    act(() => answer(YEAR_TO_MONTH_PREVIEW))
    expect(await within(dialog).findByText("Unused part of your year")).toBeTruthy()
    expect(within(dialog).getByText("about $1,489 to your balance")).toBeTruthy()
    expect(within(dialog).getByText("First month, from today")).toBeTruthy()
    expect(within(dialog).getByText("$159, paid from the balance")).toBeTruthy()
    expect(within(dialog).getByText("Charged to your card today")).toBeTruthy()
    expect(within(dialog).getByText("$0.00")).toBeTruthy()
    expect(within(dialog).getByText(/not as a refund\. It pays the next monthly charges until it runs out, about 8 months\./)).toBeTruthy()
    expect(billingApi.getPlanIntervalPreview).toHaveBeenCalledWith(ACCOUNT_ID, "month")

    await userEvent.click(within(dialog).getByRole("button", { name: "Switch to monthly" }))
    expect(onConfirm).toHaveBeenCalledWith("month", expect.stringMatching(/^[0-9a-f-]{36}$/))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  test("a failed preview falls back to the plain confirm text", async () => {
    billingApi.getPlanIntervalPreview.mockRejectedValue(createApiError(409, { error: { message: "Same", details: { code: "same_interval" } } }))
    renderSwitch()
    const dialog = await screen.findByRole("dialog")
    expect(await within(dialog).findByText(/The new price is \$159 \/ month, billed monthly\./)).toBeTruthy()
    expect(within(dialog).queryByText("Charged to your card today")).toBeNull()
    expect(within(dialog).getByRole("button", { name: "Keep yearly" })).toBeTruthy()
  })
})

describe("the 402 trial credits dialog", () => {
  test("Start Pro now is the primary action, and it opens the confirm step with the charge", async () => {
    billingApi.getStartProNowPreview.mockResolvedValue(START_PRO_NOW_PREVIEW)
    renderInRouter(<BillingDenialDialogHost />)
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
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Trial credits are used up")).toBeTruthy()
    expect(within(dialog).queryByRole("button", { name: "Upgrade" })).toBeNull()
    await userEvent.click(within(dialog).getByRole("button", { name: "Start Pro now" }))

    expect(await screen.findByRole("heading", { name: "Start Pro now?" })).toBeTruthy()
    expect(await screen.findByText(/Stripe charges \$1,548 for the year now/)).toBeTruthy()
    expect(billingApi.startProNow).not.toHaveBeenCalled()
    // Back returns to the reason.
    await userEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(await screen.findByText("Trial credits are used up")).toBeTruthy()
  })
})
