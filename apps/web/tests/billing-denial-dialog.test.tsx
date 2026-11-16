// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { CreditsExhaustedErrorDetails } from "@doxahq/contracts/billing"

import { CreditsExhaustedContent, PlanLimitContent } from "~/components/dashboard/billing/billing-denial-dialog"
import { Dialog, DialogContent } from "~/components/ui/dialog"
import { ApiRequestError, createApiError } from "~/lib/api-errors"
import { creditsExhaustedDetails, planLimitDetails } from "~/lib/dashboard/billing-model"
import { reportBillingDenial, showBillingDenial } from "~/lib/dashboard/billing-denials"

afterEach(() => {
  cleanup()
  showBillingDenial(null)
})

function details(reason: CreditsExhaustedErrorDetails["reason"]): CreditsExhaustedErrorDetails {
  return {
    code: "credits_exhausted",
    accountId: "acct-1",
    available: 12,
    needed: 400,
    reason,
    resetsAt: "2026-12-14T00:00:00.000Z",
    billingUrl: "https://doxa.test/dashboard/billing/acct-1",
  }
}

function renderReason(reason: CreditsExhaustedErrorDetails["reason"]) {
  const onAction = vi.fn()
  render(
    <Dialog open>
      <DialogContent>
        <CreditsExhaustedContent details={details(reason)} isPending={false} error={null} onAction={onAction} onClose={() => undefined} />
      </DialogContent>
    </Dialog>,
  )
  return onAction
}

describe("the 402 dialog, one action per reason (spec 10.6)", () => {
  test.each([
    ["trial_credits", "Trial credits are used up", "Start Pro now", "start_pro_now"],
    ["max_debt", "Doxa is charging your card", "View billing", "billing"],
    ["monthly_limit", "Monthly limit reached", "Raise the limit", "raise_limit"],
    ["past_due", "A payment failed", "Update the card", "update_card"],
    ["payg_off", "Monthly credits are used up", "Turn on pay-as-you-go", "turn_on_payg"],
  ] as const)("%s", async (reason, title, label, action) => {
    const onAction = renderReason(reason)
    expect(screen.getByRole("heading", { name: title })).toBeTruthy()
    expect(screen.getByText(/12 credits available\./)).toBeTruthy()
    // The run's estimate ("needs about 400") is hidden until it is reliable.
    expect(screen.queryByText(/needs about/)).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: label }))
    expect(onAction).toHaveBeenCalledWith(action)
  })

  test("trial credits: View billing is the other action", async () => {
    const onAction = renderReason("trial_credits")
    await userEvent.click(screen.getByRole("button", { name: "View billing" }))
    expect(onAction).toHaveBeenCalledWith("billing")
  })

  test("the stopped run shows when the caller knows it, else only the copy", () => {
    render(
      <Dialog open>
        <DialogContent>
          <CreditsExhaustedContent
            details={details("trial_credits")}
            run={{ action: "generation.run", repository: "acme/payments-api", branch: "main", pagesWritten: 34, pagesTotal: 50 }}
            isPending={false}
            error={null}
            onAction={() => undefined}
            onClose={() => undefined}
          />
        </DialogContent>
      </Dialog>,
    )
    expect(screen.getByText("Full generation")).toBeTruthy()
    expect(screen.getByText("acme/payments-api · main")).toBeTruthy()
    expect(screen.getByText("34 of 50 pages are written.")).toBeTruthy()
    expect(screen.getByText("Finished pages stay on the draft branch.")).toBeTruthy()
    cleanup()

    renderReason("trial_credits")
    expect(screen.queryByText("Finished pages stay on the draft branch.")).toBeNull()
    expect(screen.getByText(/Start Pro now to get 5,000 AI credits each month and continue this run\./)).toBeTruthy()
  })

  test("max_debt says that runs continue in about 20 minutes", () => {
    renderReason("max_debt")
    expect(screen.getByText("Doxa is charging your card, runs continue in about 20 minutes.")).toBeTruthy()
  })
})

describe("billing denials from the API", () => {
  test("a 402 body becomes credits details, and a 403 plan_limit becomes a gate", () => {
    const credits = createApiError(402, { error: { message: "No credits", details: details("payg_off") } })
    expect(credits).toBeInstanceOf(ApiRequestError)
    expect(creditsExhaustedDetails(credits)?.reason).toBe("payg_off")
    expect(reportBillingDenial(credits)).toBe(true)

    const limit = createApiError(403, {
      error: {
        message: "Limit",
        details: { code: "plan_limit", key: "site.custom_domains", limit: 1, used: 1, plan: "free", resetsAt: null, upgradeUrl: null },
      },
    })
    const parsed = planLimitDetails(limit)
    expect(parsed?.key).toBe("site.custom_domains")
    render(
      <Dialog open>
        <DialogContent>
          <PlanLimitContent details={parsed!} onClose={() => undefined} />
        </DialogContent>
      </Dialog>,
    )
    expect(screen.getByText("You use 1 of 1 custom domains on Free.")).toBeTruthy()
    expect(screen.getByRole("link", { name: "Upgrade" }).getAttribute("href")).toBe("/dashboard/billing")

    // Any other error is not a billing denial.
    expect(reportBillingDenial(createApiError(403, { error: { message: "Forbidden" } }))).toBe(false)
  })
})
