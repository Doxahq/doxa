import type { BillingAccountDetail } from "@doxahq/contracts/billing"

import { formatBillingDate, formatCredits } from "~/lib/dashboard/billing-model"

/**
 * The "Your Pro trial started" notice of the new project page, after the Pro
 * trial's Checkout returns there (billing spec 14.2, 15.2).
 *
 * - `none`: not a Checkout return, or the account is not in the trial.
 * - `pending`: the page waits for the plan; the notice keeps its space.
 * - `shown`: the trial is on.
 */
export type TrialStartedNotice =
  | { kind: "none" }
  | { kind: "pending" }
  | { kind: "shown"; line: string }

export const TRIAL_NOTICE_NONE: TrialStartedNotice = { kind: "none" }
export const TRIAL_NOTICE_PENDING: TrialStartedNotice = { kind: "pending" }

/** "1,000 AI credits until Nov 21, 2026. No charge until then.", or null outside the trial. */
export function trialStartedLine(detail: BillingAccountDetail): string | null {
  const subscription = detail.subscription
  if (subscription?.status !== "trialing" || !subscription.trialEnd) return null
  return `${formatCredits(detail.credits.granted)} AI credits until ${formatBillingDate(subscription.trialEnd)}. No charge until then.`
}
