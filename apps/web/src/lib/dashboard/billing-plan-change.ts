import type { BillingInterval, BillingPlanIntervalPreview, BillingStartProNowPreview } from "@doxahq/contracts/billing"

import { ApiRequestError } from "~/lib/api-errors"
import { DOXA_PRO_CREDITS, formatCents, formatCredits, formatUsd, type SwitchTarget } from "~/lib/dashboard/billing-model"
import { getErrorMessage } from "~/lib/errors"

/**
 * The words of the two plan changes: the monthly/yearly switch (spec 13) and
 * Start Pro now (decision D22). The amounts come from the provider's preview;
 * nothing here computes a charge.
 */

const PERIOD_NOUN: Record<BillingInterval, string> = { month: "month", year: "year" }
const OTHER_INTERVAL: Record<BillingInterval, BillingInterval> = { month: "year", year: "month" }

export interface SwitchDialogCopy {
  title: string
  description: string
  confirmLabel: string
  keepLabel: string
  /** The confirm text without amounts: the dialog shows it when the preview fails. */
  fallback: string
}

export function switchDialogCopy(target: SwitchTarget, isFounder: boolean): SwitchDialogCopy {
  const toYearly = target.interval === "year"
  const price = toYearly ? `${formatUsd(target.amountCents)} a year` : `${formatUsd(target.amountCents)} a month`
  const priceLine = toYearly
    ? `${formatUsd(target.monthlyCents)} / month, billed yearly at ${formatUsd(target.amountCents)}.`
    : `${formatUsd(target.amountCents)} / month, billed monthly.`
  return {
    title: toYearly ? "Switch to yearly?" : "Switch to monthly?",
    description: `Your plan changes today to ${price}.${isFounder ? " You keep the founder price." : ""}`,
    confirmLabel: toYearly ? "Switch to yearly" : "Switch to monthly",
    keepLabel: toYearly ? "Keep monthly" : "Keep yearly",
    fallback: `The new price is ${priceLine} The change starts now, and the next invoice shows the difference for the rest of this period. Pay-as-you-go usage moves to the new billing period too.`,
  }
}

export interface PreviewRow {
  label: string
  value: string
  tone: "success" | "default"
  /** The total row: bold. */
  strong: boolean
}

/** "about $1,489": a credit is an estimate until Stripe writes the invoice. */
function aboutUsd(cents: number): string {
  return `about ${formatUsd(Math.round(cents / 100) * 100)}`
}

/** The rows of the switch dialog, from the provider's preview of the switch to `preview.newInterval`. */
export function switchPreviewRows(preview: BillingPlanIntervalPreview): PreviewRow[] {
  const from = OTHER_INTERVAL[preview.newInterval]
  const rows: PreviewRow[] = []
  if (preview.creditCents > 0) {
    rows.push({
      label: `Unused part of your ${PERIOD_NOUN[from]}`,
      value: `${aboutUsd(preview.creditCents)} to your balance`,
      tone: "success",
      strong: false,
    })
  }
  const paidFromBalance = preview.creditCents >= preview.newPriceCents
  rows.push({
    label: `First ${PERIOD_NOUN[preview.newInterval]}, from today`,
    value: paidFromBalance ? `${formatUsd(preview.newPriceCents)}, paid from the balance` : formatUsd(preview.newPriceCents),
    tone: "default",
    strong: false,
  })
  rows.push({ label: "Charged to your card today", value: formatCents(preview.chargeTodayCents), tone: "default", strong: true })
  return rows
}

/** What the balance left after the switch does. It is never a refund. */
export function switchBalanceNote(preview: BillingPlanIntervalPreview): string {
  const keep = "The monthly credits and pay-as-you-go do not change."
  if (preview.balanceAfterCents <= 0) return keep
  const charges = preview.newInterval === "month" ? "monthly" : "yearly"
  const periods = preview.newPriceCents > 0 ? Math.floor(preview.balanceAfterCents / preview.newPriceCents) : 0
  const runsOut = preview.newInterval === "month" && periods >= 1 ? `, about ${periods} month${periods === 1 ? "" : "s"}` : ""
  return `Stripe keeps the balance on your account, not as a refund. It pays the next ${charges} charges until it runs out${runsOut}. ${keep}`
}

export const START_PRO_NOW_TITLE = "Start Pro now?"

/** "Ends your trial today. Stripe charges $1,548 for the year now. You get 5,000 AI credits each month." */
export function startProNowSentence(preview: BillingStartProNowPreview | null): string {
  const charge = preview
    ? `Stripe charges ${formatUsd(preview.amountCents)} for the ${PERIOD_NOUN[preview.intervalLabel]} now.`
    : "Stripe charges the plan price now."
  return `Ends your trial today. ${charge} You get ${formatCredits(DOXA_PRO_CREDITS)} AI credits each month.`
}

export type StartProNowFailure =
  | { kind: "payment_failed"; message: string }
  | { kind: "conflict"; message: string }
  | { kind: "other"; message: string }

/**
 * Why Start Pro now failed: a declined card (402 `payment_failed`, nothing
 * changed, the card can be updated in Stripe), a trial that already ended
 * (409), or anything else.
 */
export function startProNowFailure(error: unknown): StartProNowFailure {
  if (error instanceof ApiRequestError && error.fromApi) {
    if (error.status === 402 && error.code === "payment_failed") return { kind: "payment_failed", message: error.message }
    if (error.status === 409) {
      return {
        kind: "conflict",
        message:
          error.code === "not_trialing"
            ? "The trial already ended, so there is nothing to start. The page now shows the plan as it is."
            : error.message,
      }
    }
  }
  return { kind: "other", message: getErrorMessage(error, "Could not start Pro. Try again.") }
}
