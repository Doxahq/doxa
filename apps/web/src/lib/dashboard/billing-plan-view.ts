import type { BillingAccountDetail } from "@doxahq/contracts/billing"

import { cardBrandOf, type CardBrandLogo } from "~/lib/dashboard/card-brands"
import {
  creditMeterView,
  creditsToUsd,
  formatBillingDate,
  formatCredits,
  formatLimitValue,
  endedSubscriptionLine,
  formatUsd,
  isCanceledTrial,
  isPastDue,
  paygView,
  planName,
  priceOfKey,
  subscriptionView,
  type StatusTone,
} from "~/lib/dashboard/billing-model"

/**
 * Display rules of the Plan and invoices page: the plan card, the card on
 * file, the AI credits summary and the plan limits. Every number comes from
 * the account detail or the catalog.
 */

export const INVOICE_TAX_NOTE = "Prices do not include tax. Stripe adds your country's tax to each invoice."

export type PlanState = "free" | "override" | "trial" | "active" | "past_due" | "canceled" | "other"

export interface PlanBadge {
  label: string
  tone: StatusTone
}

export interface PlanCardView {
  state: PlanState
  name: string
  badges: PlanBadge[]
  /** The first line under the name: the price and renewal, the trial end, or what Free includes. */
  headline: string | null
  /** A muted line under the headline. */
  note: string | null
  /** A line under a divider at the bottom of the card. */
  footnote: string | null
}

const FOUNDER_NOTE = "The founder price stays while the plan stays active."

/** The plan card for the account's state (frames "Plan and invoices": Free, trial, Pro, past due). */
export function planCardView(detail: BillingAccountDetail): PlanCardView {
  const subscription = detail.subscription
  const view = subscriptionView(detail)
  const name = planName(detail.plan)
  if (!subscription || !view) {
    if (detail.planSource === "override") {
      return { state: "override", name, badges: [], headline: "Set by a contract with Doxa.", note: null, footnote: null }
    }
    return {
      state: "free",
      name,
      badges: [{ label: "No subscription", tone: "muted" }],
      headline: freePlanLine(detail),
      // A subscription that ended stays as a line of history, never as a status of Free.
      note: subscription ? endedSubscriptionLine(subscription) : null,
      footnote: null,
    }
  }

  const badges: PlanBadge[] = [{ label: view.statusLabel, tone: view.tone }]
  if (view.isFounder) badges.push({ label: "Founder price", tone: "muted" })
  const price = priceOfKey(subscription.priceKey)
  const priceLine = price ? `${formatUsd(price.amountCents)} / ${price.interval}` : null

  if (subscription.cancelAt) {
    return {
      state: "canceled",
      name,
      badges,
      headline: `Ends on ${formatBillingDate(subscription.cancelAt)}`,
      note: `${name} stays until then. You can resume it in Stripe.`,
      footnote: null,
    }
  }
  if (subscription.status === "trialing") {
    const trialEnd = subscription.trialEnd ? formatBillingDate(subscription.trialEnd) : null
    const then = price
      ? `Then ${formatUsd(price.amountCents)} ${price.interval === "year" ? "for the year" : "a month"}${view.isFounder ? " at the founder price" : ""}`
      : null
    return {
      state: "trial",
      name,
      badges,
      headline: trialEnd ? `Trial ends on ${trialEnd}` : "Trial",
      note: then ? `${then}${trialEnd ? `, charged on ${trialEnd}` : ""}.` : null,
      footnote: trialEnd ? `Cancel before ${trialEnd} and you pay nothing. Your docs stay online on Free.` : null,
    }
  }
  if (subscription.status === "past_due") {
    return {
      state: "past_due",
      name,
      badges,
      headline: "The last payment failed. Update your card to keep Pro.",
      note: "Stripe tries the card again automatically.",
      footnote: null,
    }
  }
  if (subscription.status === "active") {
    return {
      state: "active",
      name,
      badges,
      headline: [priceLine, view.periodLine].filter(Boolean).join(" · ") || null,
      note: view.isFounder ? FOUNDER_NOTE : null,
      footnote: null,
    }
  }
  return { state: "other", name, badges, headline: priceLine, note: null, footnote: null }
}

function freePlanLine(detail: BillingAccountDetail): string {
  const domains = detail.entitlements.limits["site.custom_domains"]
  const domainText =
    domains === "unlimited" ? "custom domains" : domains === undefined ? null : `${formatCredits(domains)} custom domain${domains === 1 ? "" : "s"}`
  const includes = domainText ? `Hosting, the editor, ${domainText} and MCP.` : "Hosting, the editor and MCP."
  return `${includes} Full generations and update runs need Pro.`
}

export interface PaymentMethodView {
  /** The brand logo in the card chip, or null for the generic card icon. */
  logo: CardBrandLogo | null
  title: string
  detail: string
  /** The detail line is a problem (the last charge failed). */
  isProblem: boolean
}

/** "Visa ending 4242 · Expires 08/2029", or "Managed in Stripe" when the API has no card to show. */
export function paymentMethodView(detail: BillingAccountDetail): PaymentMethodView {
  const card = detail.paymentMethod
  const pastDue = isPastDue(detail)
  if (!card) {
    return {
      logo: null,
      title: "Managed in Stripe",
      detail: pastDue
        ? "The last charge failed. Update the payment method in Stripe."
        : "Stripe keeps the card or Link account that pays for the plan.",
      isProblem: pastDue,
    }
  }
  const brand = cardBrandOf(card.brand)
  const expires = `Expires ${String(card.expMonth).padStart(2, "0")}/${card.expYear}`
  const trialEnd = detail.subscription?.status === "trialing" ? detail.subscription.trialEnd : null
  const use = pastDue
    ? "the last charge failed"
    : trialEnd
      ? `first charge on ${formatBillingDate(trialEnd)}`
      : "Stripe charges this card for the plan and for pay-as-you-go"
  return { logo: brand.logo, title: `${brand.name} ending ${card.last4}`, detail: `${expires} · ${use}`, isProblem: pastDue }
}

/** True when the account has AI features, so the AI credits page has something to show. */
export function hasAiCredits(detail: BillingAccountDetail): boolean {
  const features = detail.entitlements.features
  return features["ai.doxa_agent"] === true || features["ai.doxabot"] === true
}

/** "0 of 10,000 monthly credits left · pay-as-you-go on, $9.20 of $30 used this month". */
export function creditsSummaryLine(detail: BillingAccountDetail): string {
  const meter = creditMeterView(detail)
  const trialing = detail.subscription?.status === "trialing"
  const pool = trialing ? "trial" : "monthly"
  const left =
    meter.total === null ? `${formatCredits(meter.left)} credits left` : `${formatCredits(meter.left)} of ${formatCredits(meter.total)} ${pool} credits left`
  if (trialing) return isCanceledTrial(detail) ? `${left} · the trial will not renew` : `${left} · pay-as-you-go starts when the trial ends`
  const payg = paygView(detail, [])
  if (payg.paymentFailed) return `${left} · pay-as-you-go paused until the invoice is paid`
  if (detail.payg.active) return `${left} · pay-as-you-go on, ${payg.monthTotalUsd.replace(/\.00$/, "")} of ${payg.monthlyLimitUsd} used this month`
  if (detail.payg.offReason === "setting_off") return `${left} · pay-as-you-go off`
  return left
}

export interface PlanLimitRow {
  key: string
  label: string
  value: string
}

const PLAN_LIMITS: readonly { key: string; label: string }[] = [
  { key: "site.custom_domains", label: "Custom domains" },
  { key: "docs.branches_per_site", label: "Branches per site" },
  { key: "docs.storage_bytes", label: "Docs storage" },
  { key: "mcp.tool_calls_per_day", label: "MCP tool calls a day" },
  { key: "docs.export_window_hours", label: "Docs exports" },
  { key: "team.seats", label: "Team seats" },
]

/**
 * The limits of the account's plan, from its entitlements. The API sends no
 * use for them, so the list shows the limits only.
 */
export function planLimitRows(detail: BillingAccountDetail): PlanLimitRow[] {
  const rows: PlanLimitRow[] = []
  for (const { key, label } of PLAN_LIMITS) {
    const value = detail.entitlements.limits[key]
    if (value !== undefined) rows.push({ key, label, value: formatLimitValue(key, value) })
  }
  return rows
}

/** "920 credits · $9.20": an amount in credits and its price. */
export function creditsAndUsd(credits: number): string {
  return `${formatCredits(credits)} credits · ${creditsToUsd(credits)}`
}
