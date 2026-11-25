import { DOXA_CATALOG, type BillingInterval } from "@doxahq/billing/catalog"
import type { BillingOffer } from "@doxahq/contracts/billing"

import { formatCredits, formatUsd } from "~/lib/dashboard/billing-model"

/**
 * The copy and the price lines of the Pro trial dialog (billing spec 3, 15.2).
 * The trial length comes from the catalog, the prices only from
 * `GET /billing/offers`.
 */

const proTrial = DOXA_CATALOG.plans.pro.trial
export const PRO_TRIAL_DAYS = proTrial?.days ?? 0

/** "Try Doxa Pro free for 7 days": the title of the Pro trial dialog. */
export const PRO_TRIAL_TITLE = `Try Doxa Pro free for ${PRO_TRIAL_DAYS} days`

/** "1,000": the AI credits of the trial. */
export const PRO_TRIAL_CREDITS = formatCredits(proTrial?.credits ?? 0)

/** The labels of the trial terms: today, during the trial, and when it ends. */
export const PRO_TRIAL_TERMS = {
  today: "Today",
  todayValue: "$0 · card required",
  inTrial: "In the trial",
  inTrialValue: `${PRO_TRIAL_CREDITS} AI credits`,
  afterTrial: `In ${PRO_TRIAL_DAYS} days`,
} as const

/** Under the terms, beside the actions: what a cancel during the trial costs. */
export const PRO_TRIAL_CANCEL_LINE = "Cancel before the trial ends and you pay nothing."

/** The dialog for an account that already had a trial: Checkout charges at once. */
export const PRO_UPGRADE_TITLE = "Upgrade to Doxa Pro"
export const PRO_UPGRADE_ACTION = "Upgrade to Pro"
export const PRO_NO_TRIAL_LINE = "This account already had a trial, so Stripe charges the first payment today."

/** The price lines of the Pro trial dialog for one interval. */
export interface ProOfferPriceView {
  /** "$99", the monthly amount; null when no price is known. */
  amount: string | null
  /** "Billed yearly at $1,188" or "Billed monthly". */
  billedLine: string
  /** The first charge when the trial ends: "$1,188 for the year" or "$129 for the first month". */
  firstCharge: string
  /** "Founder price" while the founder offer is open: the offer's label, with no spots count. */
  founderLine: string | null
  yearlySavingsPercent: number
}

/**
 * The prices come only from `GET /billing/offers`: the founder prices while
 * the offer is open, the standard prices that the response gives once it is
 * closed. With no offer, the lines name no amount.
 */
export function proOfferPriceView(offer: BillingOffer | null, interval: BillingInterval): ProOfferPriceView {
  const yearly = interval === "year"
  if (!offer) {
    return {
      amount: null,
      billedLine: yearly ? "Billed yearly" : "Billed monthly",
      firstCharge: yearly ? "The first year of Pro" : "The first month of Pro",
      founderLine: null,
      yearlySavingsPercent: 0,
    }
  }
  const price = offer.prices[interval]
  const total = formatUsd(price.amountCents)
  return {
    amount: formatUsd(yearly ? price.monthlyEquivalentCents : price.amountCents),
    billedLine: yearly ? `Billed yearly at ${total}` : "Billed monthly",
    firstCharge: yearly ? `${total} for the year` : `${total} for the first month`,
    founderLine: offer.open ? offer.label : null,
    yearlySavingsPercent: offer.yearlySavingsPercent,
  }
}
