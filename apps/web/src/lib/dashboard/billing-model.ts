import {
  DOXA_CATALOG,
  FREE_TEAMS_PER_OWNER_KEY,
  findOfferOfPrice,
  formatUsd,
  monthlyEquivalentCents,
  type BillingInterval,
} from "@doxahq/billing/catalog"
import {
  creditsExhaustedErrorDetailsSchema,
  planLimitErrorDetailsSchema,
  type BillingAccountDetail,
  type BillingInvoice,
  type BillingLedgerEntry,
  type BillingOffer,
  type CreditEstimate,
  type CreditsExhaustedErrorDetails,
  type PlanLimitErrorDetails,
} from "@doxahq/contracts/billing"

import { ApiRequestError } from "~/lib/api-errors"

/**
 * Display rules of the billing screens (billing spec 15.2). Prices, limits and
 * the pay-as-you-go rules come from the catalog; account numbers come from the
 * API. Nothing here computes a charge: the API and the provider do.
 */

export const CREDIT_UNIT_PRICE_CENTS = DOXA_CATALOG.credit.unitPriceCents
export const PAYG = DOXA_CATALOG.payg
export const FOUNDER_OFFER_KEY = "founder_v1"

export { formatUsd }

const proMonthlyCredits = DOXA_CATALOG.plans.pro.limits["ai.credits_monthly"]
/** The Pro allowance (10,000). */
export const DOXA_PRO_CREDITS = typeof proMonthlyCredits === "number" ? proMonthlyCredits : 0
const proTrial = DOXA_CATALOG.plans.pro.trial
export const TRIAL_SENTENCE = proTrial
  ? `${proTrial.days}-day trial with ${new Intl.NumberFormat("en-US").format(proTrial.credits)} credits.`
  : ""

/** The sentence of the pay-as-you-go card (decision D19: no Pay now). */
export const PAYG_CHARGE_SENTENCE = `Doxa charges your card automatically when your balance reaches ${formatUsd(
  PAYG.chargeAtCredits * CREDIT_UNIT_PRICE_CENTS,
)}, and once a month.`

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })

/** `Dec 14, 2026`, in UTC so a date reads the same for every viewer and in tests. */
export function formatBillingDate(iso: string): string {
  return DATE_FORMAT.format(new Date(iso))
}

export function formatCredits(credits: number): string {
  return new Intl.NumberFormat("en-US").format(credits)
}

/** `$2.40`: credits at the catalog price, always with cents. */
export function creditsToUsd(credits: number): string {
  return formatUsd(credits * CREDIT_UNIT_PRICE_CENTS, { cents: true })
}

export function formatCents(cents: number): string {
  return formatUsd(cents, { cents: true })
}

export function planName(plan: string): string {
  return DOXA_CATALOG.plans[plan as keyof typeof DOXA_CATALOG.plans]?.name ?? plan
}

const ACTION_LABELS: Record<string, string> = {
  "generation.run": "Full generation",
  "doxabot.run": "Update run",
  "docs_chat.answer": "Docs chat answer",
  "mcp.tool_call": "MCP tool call",
}

export function actionLabel(action: string | null): string {
  if (!action) return "Credits"
  return ACTION_LABELS[action] ?? action
}

/**
 * How a run of a metered action starts, and when Doxa uses it. A pull
 * request or merge run without a cache is a full generation (`COLD`); with
 * the cache of the last run it is an update run (`WARM`).
 */
export interface ActionDescription {
  tag: "COLD" | "WARM"
  /** What the run does. */
  summary: string
  /** Which runs use the action. */
  usedBy: string
}

const ACTION_DESCRIPTIONS: Record<string, ActionDescription> = {
  "generation.run": {
    tag: "COLD",
    summary: "No cache: reads the whole repository and plans the site from scratch.",
    usedBy:
      "Used by the first generation, after Clear cache, and by pull request runs before the first publish. Generations you start always count here too.",
  },
  "doxabot.run": {
    tag: "WARM",
    summary: "Starts from the cache of the last run: reads only the changed files and rewrites only the pages they affect.",
    usedBy: "Used by pull request previews and runs after a merge.",
  },
}

export function actionDescription(action: string): ActionDescription | null {
  return ACTION_DESCRIPTIONS[action] ?? null
}

export function priceOfKey(priceKey: string) {
  return DOXA_CATALOG.prices[priceKey as keyof typeof DOXA_CATALOG.prices] ?? null
}

export function intervalOfPriceKey(priceKey: string): BillingInterval | null {
  return priceOfKey(priceKey)?.interval ?? null
}

export function intervalLabel(interval: BillingInterval): string {
  return interval === "year" ? "Yearly" : "Monthly"
}

export function isFounderPrice(priceKey: string): boolean {
  return findOfferOfPrice(DOXA_CATALOG, priceKey) !== null
}

/**
 * The price a switch to the other interval moves to. A founder stays on the
 * founder price of the other interval (spec 7.5 rule 5), everyone else gets
 * the standard price of that interval.
 */
export function switchTargetPrice(priceKey: string): { interval: BillingInterval; priceKey: string; amountCents: number; monthlyCents: number } | null {
  const current = priceOfKey(priceKey)
  if (!current) return null
  const interval: BillingInterval = current.interval === "year" ? "month" : "year"
  for (const offer of Object.values(DOXA_CATALOG.offers)) {
    const list = Object.values(offer.prices).includes(priceKey as never)
      ? offer.prices
      : Object.values(offer.then).includes(priceKey as never)
        ? offer.then
        : null
    if (!list) continue
    const targetKey = list[interval]
    const target = priceOfKey(targetKey)
    if (!target) return null
    return { interval, priceKey: targetKey, amountCents: target.amountCents, monthlyCents: monthlyEquivalentCents(target) }
  }
  return null
}

export type SwitchTarget = NonNullable<ReturnType<typeof switchTargetPrice>>

export type StatusTone = "success" | "warning" | "danger" | "muted"

export interface SubscriptionView {
  statusLabel: string
  tone: StatusTone
  /** "Renews on Dec 14, 2026", "Ends on …", "Trial ends on …". */
  periodLine: string | null
  interval: BillingInterval | null
  priceLine: string | null
  isFounder: boolean
}

export function subscriptionView(detail: BillingAccountDetail): SubscriptionView | null {
  const subscription = detail.subscription
  // An ended subscription is history: the account is on Free (see planCardView).
  if (!subscription || isEndedSubscription(subscription)) return null
  const price = priceOfKey(subscription.priceKey)
  const interval = price?.interval ?? null
  const priceLine = price
    ? interval === "year"
      ? `${formatUsd(monthlyEquivalentCents(price))} / month, billed yearly at ${formatUsd(price.amountCents)}`
      : `${formatUsd(price.amountCents)} / month, billed monthly`
    : null
  const isFounder = isFounderPrice(subscription.priceKey)
  const base = { interval, priceLine, isFounder }
  if (subscription.cancelAt) {
    return { ...base, statusLabel: "Canceled", tone: "warning", periodLine: `Ends on ${formatBillingDate(subscription.cancelAt)}` }
  }
  switch (subscription.status) {
    case "trialing":
      return {
        ...base,
        statusLabel: "Trial",
        tone: "success",
        periodLine: subscription.trialEnd ? `Trial ends on ${formatBillingDate(subscription.trialEnd)}` : null,
      }
    case "active":
      return { ...base, statusLabel: "Active", tone: "success", periodLine: `Renews on ${formatBillingDate(subscription.currentPeriodEnd)}` }
    case "past_due":
      return { ...base, statusLabel: "Past due", tone: "danger", periodLine: "The last payment failed. Update your card to keep Pro." }
    default:
      return { ...base, statusLabel: subscription.status.replace(/_/g, " "), tone: "muted", periodLine: null }
  }
}

/** True while the account has a subscription that still gives the plan. */
export function hasLiveSubscription(detail: BillingAccountDetail): boolean {
  const status = detail.subscription?.status
  return status === "trialing" || status === "active" || status === "past_due"
}

export function isPastDue(detail: BillingAccountDetail): boolean {
  return detail.subscription?.status === "past_due" || detail.aiPausedReason === "payment_failed"
}

export interface CreditMeterView {
  /** The size of the pool: the monthly allowance, or the trial credits. */
  total: number | null
  left: number
  used: number
  percentUsed: number
  label: string
  resetLine: string
  held: number
}

type AccountSubscription = NonNullable<BillingAccountDetail["subscription"]>

/** Stripe statuses of a subscription that is over. The account keeps it only as history. */
const ENDED_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(["canceled", "incomplete_expired"])

export function isEndedSubscription(subscription: AccountSubscription): boolean {
  return ENDED_SUBSCRIPTION_STATUSES.has(subscription.status)
}

/** "Your Pro trial ended on Nov 22, 2026." or "Your Pro plan ended on …", for a subscription that is over. */
export function endedSubscriptionLine(subscription: AccountSubscription): string {
  const endedAt = subscription.cancelAt ?? subscription.currentPeriodEnd
  const wasTrial = subscription.trialEnd !== null && Date.parse(endedAt) <= Date.parse(subscription.trialEnd)
  return `Your Pro ${wasTrial ? "trial" : "plan"} ended on ${formatBillingDate(endedAt)}.`
}

/** A trial that is canceled: it ends on its date, and no plan or pay-as-you-go follows it. */
export function isCanceledTrial(detail: BillingAccountDetail): boolean {
  return detail.subscription?.status === "trialing" && detail.subscription.cancelAt !== null
}

export function creditMeterView(detail: BillingAccountDetail): CreditMeterView {
  const { credits } = detail
  const trialing = detail.subscription?.status === "trialing"
  const trialCredits = DOXA_CATALOG.plans.pro.trial?.credits ?? 0
  const total = trialing ? trialCredits : credits.allowance === "unlimited" ? null : credits.allowance
  const left = Math.max(0, total === null ? credits.granted : Math.min(credits.granted, total))
  const used = total === null ? 0 : Math.max(0, total - left)
  const percentUsed = total ? Math.min(100, Math.round((used / total) * 100)) : 0
  return {
    total,
    left,
    used,
    percentUsed,
    label: trialing ? "Trial credits" : "Monthly AI credits",
    resetLine: trialing
      ? isCanceledTrial(detail)
        ? "Trial credits do not reset. The trial will not renew, so no monthly allowance follows it."
        : "Trial credits do not reset. The monthly allowance starts when the trial ends."
      : `Resets on ${formatBillingDate(credits.allowanceResetsAt)}`,
    held: credits.held,
  }
}

/** Why pay-as-you-go is off, in the words of the card. */
const PAYG_OFF_TEXT: Record<string, string> = {
  not_in_plan: "Pay-as-you-go comes with Pro.",
  trial: "Pay-as-you-go starts when the trial ends. During the trial, runs stop when the trial credits run out.",
  canceled_trial: "The trial will not renew, so pay-as-you-go does not start. Runs stop when the trial credits run out.",
  setting_off: "Pay-as-you-go is off. Runs stop when the monthly credits run out.",
  payment_failed: "A charge failed, so pay-as-you-go is off until the invoice is paid. The monthly credits still work.",
  dispute: "A payment dispute is open, so pay-as-you-go is off.",
}

export interface PaygView {
  debtUsd: string
  /** A threshold or sweep invoice is open and not paid or failed yet (spec 10.10 step 3). */
  chargeInProgress: boolean
  paymentFailed: boolean
  /** The unpaid usage invoice to pay after a failed charge. */
  unpaidInvoice: BillingInvoice | null
  pastCharges: BillingInvoice[]
  monthTotalUsd: string
  monthlyLimitUsd: string
  percentOfLimit: number
  nextSweepLine: string
  offText: string | null
  rangeCents: readonly [number, number]
}

function paygOffKey(detail: BillingAccountDetail): string {
  const reason = detail.payg.offReason ?? "setting_off"
  return reason === "trial" && isCanceledTrial(detail) ? "canceled_trial" : reason
}

export function paygView(detail: BillingAccountDetail, invoices: readonly BillingInvoice[]): PaygView {
  const { payg } = detail
  const paymentFailed = payg.offReason === "payment_failed" || detail.aiPausedReason === "payment_failed"
  const usageInvoices = invoices.filter((invoice) => invoice.usageCredits > 0)
  const unpaidInvoice = paymentFailed
    ? (usageInvoices.find((invoice) => invoice.status === "open" && invoice.hostedInvoiceUrl) ?? null)
    : null
  const monthTotalCents = payg.monthTotal * CREDIT_UNIT_PRICE_CENTS
  return {
    debtUsd: creditsToUsd(payg.debt),
    chargeInProgress: payg.thresholdInvoiceOpen,
    paymentFailed,
    unpaidInvoice,
    pastCharges: usageInvoices.filter((invoice) => invoice.status === "paid"),
    monthTotalUsd: formatCents(monthTotalCents),
    monthlyLimitUsd: formatUsd(payg.monthlyLimitCents),
    percentOfLimit: payg.monthlyLimitCents > 0 ? Math.min(100, Math.round((monthTotalCents / payg.monthlyLimitCents) * 100)) : 0,
    // The API answers the next sweep date; null without an active or past-due paid subscription.
    nextSweepLine: payg.nextSweepAt ? `Next monthly charge: ${formatBillingDate(payg.nextSweepAt)}` : "No monthly charge scheduled.",
    offText: payg.active ? null : (PAYG_OFF_TEXT[paygOffKey(detail)] ?? PAYG_OFF_TEXT.setting_off ?? null),
    rangeCents: payg.monthlyLimitRangeCents,
  }
}

/** Whole dollars between the catalog's bounds, or an error line. */
export function parseMonthlyLimit(value: string, rangeCents: readonly [number, number]): { cents: number } | { error: string } {
  const dollars = Number(value.trim().replace(/^\$/, ""))
  const [min, max] = rangeCents
  const message = `Enter a whole amount from ${formatUsd(min)} to ${formatUsd(max)}.`
  if (!Number.isInteger(dollars)) return { error: message }
  const cents = dollars * 100
  if (cents < min || cents > max) return { error: message }
  return { cents }
}

/** A cap in credits from the base fee (`min`) up to `max`, or an error line that says what to change. */
export function parseCap(value: string, min: number, max: number): { credits: number } | { error: string } {
  const text = value.trim().replace(/,/g, "")
  const credits = Number(text)
  if (text === "" || !Number.isFinite(credits)) return { error: `Enter a cap in credits, from ${formatCredits(min)} to ${formatCredits(max)}.` }
  if (!Number.isInteger(credits)) return { error: "Use whole credits, with no decimals." }
  if (credits < min) return { error: `The lowest cap is ${formatCredits(min)} credits.` }
  if (credits > max) return { error: `The highest cap is ${formatCredits(max)} credits.` }
  return { credits }
}

const INVOICE_REASON_LABELS: Record<string, string> = {
  subscription_create: "Doxa Pro",
  subscription_cycle: "Doxa Pro · renewal",
  subscription_update: "Doxa Pro · plan change",
  threshold: "Pay-as-you-go",
  final: "Final invoice",
  manual: "Invoice",
  other: "Invoice",
}

export function invoiceReasonLabel(reason: string): string {
  return INVOICE_REASON_LABELS[reason] ?? "Invoice"
}

export function invoiceStatusView(invoice: BillingInvoice): { label: string; tone: StatusTone } {
  switch (invoice.status) {
    case "paid":
      return { label: "Paid", tone: "success" }
    case "open":
      return { label: "Due", tone: "warning" }
    case "uncollectible":
      return { label: "Unpaid", tone: "danger" }
    case "void":
      return { label: "Void", tone: "muted" }
    default:
      return { label: invoice.status, tone: "muted" }
  }
}

/** An open invoice has a payment page: the list shows "Pay". */
export function invoiceNeedsPayment(invoice: BillingInvoice): boolean {
  return invoice.status === "open" && invoice.amountDueCents > invoice.amountPaidCents && invoice.hostedInvoiceUrl !== null
}

/** A run, or credits that were added or charged (grants, paid charges, adjustments). */
export type CreditHistoryKind = "run" | "added"

export interface CreditHistoryRow {
  id: string
  kind: CreditHistoryKind
  createdAt: string
  title: string
  /** The job of a run, for a link or a short ID. */
  subjectId: string | null
  /** Signed: negative for credits used, positive for credits added. */
  credits: number
  /** The part of a run above the grants, in credits. */
  fromPayg: number
}

const ENTRY_TITLES: Record<string, string> = {
  grant: "Credits added",
  expire: "Credits expired",
  revoke: "Credits removed",
  adjust: "Adjustment",
  debt_paid: "Pay-as-you-go charge paid",
  shortfall: "Covered by Doxa",
}

/**
 * One row for each run (spec 15.2): a settle writes a debit, maybe a debt and
 * a release with the same subject. Entries without a subject keep one row
 * each. The API sends entries newest first, and so do the rows.
 */
export function creditHistoryRows(entries: readonly BillingLedgerEntry[]): CreditHistoryRow[] {
  const rows: CreditHistoryRow[] = []
  const runs = new Map<string, CreditHistoryRow>()
  for (const entry of entries) {
    const runKey = entry.subjectId && entry.actionKey ? `${entry.subjectKind ?? ""}:${entry.subjectId}` : null
    if (runKey) {
      const usage = entry.kind === "debit" || entry.kind === "debt" ? entry.credits : 0
      const existing = runs.get(runKey)
      if (existing) {
        existing.credits += usage
        if (entry.kind === "debt") existing.fromPayg += -entry.credits
        continue
      }
      const row: CreditHistoryRow = {
        id: entry.id,
        kind: "run",
        createdAt: entry.createdAt,
        title: actionLabel(entry.actionKey),
        subjectId: entry.subjectId,
        credits: usage,
        fromPayg: entry.kind === "debt" ? -entry.credits : 0,
      }
      runs.set(runKey, row)
      rows.push(row)
      continue
    }
    if (entry.kind === "release" && entry.credits === 0) continue
    rows.push({
      id: entry.id,
      kind: "added",
      createdAt: entry.createdAt,
      title: ENTRY_TITLES[entry.kind] ?? entry.kind,
      subjectId: null,
      credits: entry.credits,
      fromPayg: 0,
    })
  }
  return rows
}

/** The credit history filter: every row, the runs, or the credits added and charged. */
export const CREDIT_HISTORY_FILTERS = [
  { value: "all", label: "All" },
  { value: "run", label: "Runs" },
  { value: "added", label: "Added and charged" },
] as const satisfies readonly { value: CreditHistoryKind | "all"; label: string }[]
export type CreditHistoryFilter = (typeof CREDIT_HISTORY_FILTERS)[number]["value"]

export function filterCreditHistory(rows: readonly CreditHistoryRow[], filter: CreditHistoryFilter): CreditHistoryRow[] {
  return filter === "all" ? [...rows] : rows.filter((row) => row.kind === filter)
}

/**
 * The activity of a history row: "Full generation · 2,610 monthly, 500
 * pay-as-you-go" for a run that went past the grants, else the title.
 */
export function creditHistoryActivity(row: CreditHistoryRow): string {
  if (row.kind !== "run" || row.fromPayg <= 0) return row.title
  const fromGrants = Math.max(0, -row.credits - row.fromPayg)
  return `${row.title} · ${formatCredits(fromGrants)} monthly, ${formatCredits(row.fromPayg)} pay-as-you-go`
}

/** "−300", "+5,000" or "0", and its tone: credits added are green, a run that cost nothing is muted. */
export function creditHistoryAmount(row: CreditHistoryRow): { text: string; tone: "success" | "default" | "muted" } {
  if (row.credits > 0) return { text: `+${formatCredits(row.credits)}`, tone: "success" }
  if (row.credits < 0) return { text: `−${formatCredits(-row.credits)}`, tone: "default" }
  return { text: "0", tone: "muted" }
}

/** "About 220–300 credits. Stops at 3,000." (spec 10.5). */
export function estimateSentence(estimate: CreditEstimate): string {
  const range = estimate.low === estimate.high ? formatCredits(estimate.high) : `${formatCredits(estimate.low)}–${formatCredits(estimate.high)}`
  return `About ${range} credits. Stops at ${formatCredits(estimate.cap)}.`
}

/**
 * "About $2.40 from pay-as-you-go" when the top of the estimate is above the
 * credits left in the grants and pay-as-you-go is on (spec 15.2).
 */
export function estimatePaygSentence(estimate: CreditEstimate, detail: BillingAccountDetail | null): string | null {
  if (!detail || !detail.payg.active) return null
  const above = estimate.high - Math.max(0, detail.credits.granted)
  if (above <= 0) return null
  return `About ${creditsToUsd(above)} from pay-as-you-go`
}

export function founderSpotsLine(offer: BillingOffer): string | null {
  if (!offer.open) return null
  return `${formatCredits(offer.slotsLeft)} of ${formatCredits(offer.maxAccounts)} founder spots left · price locked in forever`
}

export function founderOffer(offers: readonly BillingOffer[]): BillingOffer | null {
  return offers.find((offer) => offer.offerKey === FOUNDER_OFFER_KEY) ?? offers[0] ?? null
}

export type CreditsExhaustedReason = CreditsExhaustedErrorDetails["reason"]
export type CreditsExhaustedAction = "start_pro_now" | "billing" | "raise_limit" | "update_card" | "turn_on_payg"

/**
 * The 402 dialog for each reason (spec 10.6). `secondary` is the other
 * button: an action, or null to close. `note` is a line under the run.
 */
export const CREDITS_EXHAUSTED_COPY: Record<
  CreditsExhaustedReason,
  {
    title: string
    body: string
    action: CreditsExhaustedAction
    actionLabel: string
    secondary: { label: string; action: CreditsExhaustedAction | null }
    note: string | null
  }
> = {
  trial_credits: {
    title: "Trial credits are used up",
    body: `Your trial credits ran out. Start Pro now to get ${formatCredits(DOXA_PRO_CREDITS)} AI credits each month and continue this run.`,
    action: "start_pro_now",
    actionLabel: "Start Pro now",
    secondary: { label: "View billing", action: "billing" },
    note: "Start Pro now ends the trial today and charges the plan. The next step shows the amount.",
  },
  max_debt: {
    title: "Doxa is charging your card",
    body: "Doxa is charging your card, runs continue in about 20 minutes.",
    action: "billing",
    actionLabel: "View billing",
    secondary: { label: "Close", action: null },
    note: "Stripe makes the invoice about 15 to 20 minutes after the usage. When it is paid, you can continue the run.",
  },
  monthly_limit: {
    title: "Monthly limit reached",
    body: "This account reached its monthly pay-as-you-go limit. Raise the limit to continue now, or wait for the next month.",
    action: "raise_limit",
    actionLabel: "Raise the limit",
    secondary: { label: "Not now", action: null },
    note: null,
  },
  past_due: {
    title: "A payment failed",
    body: "The last charge failed, so AI actions above the monthly credits are paused. Update the card to continue.",
    action: "update_card",
    actionLabel: "Update the card",
    secondary: { label: "Not now", action: null },
    note: null,
  },
  payg_off: {
    title: "Monthly credits are used up",
    body: "Pay-as-you-go is off for this account. Turn it on to continue at $0.01 per credit, or wait for the next month.",
    action: "turn_on_payg",
    actionLabel: "Turn on pay-as-you-go",
    secondary: { label: "Not now", action: null },
    note: `Pay-as-you-go stops at your monthly limit (${formatUsd(PAYG.defaultMonthlyLimitCents)} by default). ${PAYG_CHARGE_SENTENCE}`,
  },
}

/**
 * The run a 402 stopped, when the caller knows it. The 402 details name no
 * job, so the dialog shows this only when a caller passes it.
 */
export interface StoppedRunSummary {
  action: string
  repository: string | null
  branch: string | null
  pagesWritten: number | null
  pagesTotal: number | null
}

/** "Full generation", "acme/api · main", "34 of 50 pages are written." */
export function stoppedRunLines(run: StoppedRunSummary): { title: string; source: string | null; pages: string | null } {
  const source = [run.repository, run.branch].filter((part): part is string => Boolean(part)).join(" · ") || null
  const pages =
    run.pagesWritten === null
      ? null
      : run.pagesTotal === null
        ? `${formatCredits(run.pagesWritten)} ${run.pagesWritten === 1 ? "page is" : "pages are"} written.`
        : `${formatCredits(run.pagesWritten)} of ${formatCredits(run.pagesTotal)} pages are written.`
  return { title: actionLabel(run.action), source, pages }
}

/** The details of a 402 `credits_exhausted` answer, else null. */
export function creditsExhaustedDetails(error: unknown): CreditsExhaustedErrorDetails | null {
  if (!(error instanceof ApiRequestError) || error.status !== 402) return null
  const parsed = creditsExhaustedErrorDetailsSchema.safeParse(error.details)
  return parsed.success ? parsed.data : null
}

/** The details of a 403 `plan_limit` answer, else null. */
export function planLimitDetails(error: unknown): PlanLimitErrorDetails | null {
  if (!(error instanceof ApiRequestError) || error.status !== 403) return null
  const parsed = planLimitErrorDetailsSchema.safeParse(error.details)
  return parsed.success ? parsed.data : null
}

const LIMIT_LABELS: Record<string, string> = {
  "docs.branches_per_site": "branches on this site",
  "docs.storage_bytes": "docs storage",
  "site.asset_bytes": "site file storage",
  "site.asset_files": "site files",
  "site.custom_domains": "custom domains",
  "team.seats": "team seats",
  "account.projects": "projects",
  "mcp.tool_calls_per_day": "MCP tool calls today",
  "docs.export_window_hours": "docs exports",
  "ai.credits_monthly": "AI credits",
}

const FEATURE_LABELS: Record<string, string> = {
  "ai.doxa_agent": "The Doxa Agent",
  "ai.doxabot": "Doxabot",
  "docs.publish_approvals": "Approval before publish",
  "site.remove_powered_by": "Removing the \"Powered by Doxa\" badge",
  "team.role_permissions": "Role-based permissions",
  "agents.approval_rules": "Approval rules for agents",
}

const BYTE_LIMITS = new Set(["docs.storage_bytes", "site.asset_bytes"])

/** "1", "100 MB", or "Unlimited". */
export function formatLimitValue(key: string, value: number | "unlimited"): string {
  return value === "unlimited" ? "Unlimited" : formatLimitNumber(key, value)
}

function formatLimitNumber(key: string, value: number): string {
  if (key === "docs.export_window_hours") return formatExportWindow(value)
  if (!BYTE_LIMITS.has(key)) return formatCredits(value)
  const mb = value / (1024 * 1024)
  return mb >= 1024 ? `${Math.round(mb / 1024)} GB` : `${Math.round(mb)} MB`
}

/** "Once every 24 hours", "Once an hour", or "Unlimited" for a window of 0 hours. */
function formatExportWindow(hours: number): string {
  if (hours === 0) return "Unlimited"
  if (hours === 24) return "Once every 24 hours"
  if (hours === 1) return "Once an hour"
  return `Once every ${hours} hours`
}

/** "one Free team" or "2 Free teams": the limit of `FREE_TEAMS_PER_OWNER_KEY`. */
function freeTeamsLimitPhrase(limit: PlanLimitErrorDetails["limit"]): string {
  const count = typeof limit === "number" ? limit : DOXA_CATALOG.teams.freeTeamsPerOwner
  return count === 1 ? "one Free team" : `${count} Free teams`
}

/** "You use 1 of 1 custom domains on Free." or "Doxabot needs Pro." */
export function planLimitSentence(details: PlanLimitErrorDetails): string {
  // Not a plan limit: no plan of the user changes it, only a team upgrade.
  if (details.key === FREE_TEAMS_PER_OWNER_KEY) {
    return `Each person can own ${freeTeamsLimitPhrase(details.limit)}. Upgrade a Free team that you own to create more teams.`
  }
  const plan = details.plan ? planName(details.plan) : null
  if (typeof details.limit === "boolean") {
    return `${FEATURE_LABELS[details.key] ?? "This feature"} needs a paid plan${plan ? `. You are on ${plan}` : ""}.`
  }
  const label = LIMIT_LABELS[details.key] ?? details.key
  const limit = details.limit === "unlimited" ? "unlimited" : formatLimitNumber(details.key, details.limit)
  const used = details.used === null ? null : formatLimitNumber(details.key, details.used)
  const suffix = plan ? ` on ${plan}` : ""
  return used === null ? `The limit is ${limit} ${label}${suffix}.` : `You use ${used} of ${limit} ${label}${suffix}.`
}

type CatalogPlan = (typeof DOXA_CATALOG.plans)[keyof typeof DOXA_CATALOG.plans]

function catalogPlan(plan: string): CatalogPlan | null {
  return DOXA_CATALOG.plans[plan as keyof typeof DOXA_CATALOG.plans] ?? null
}

function limitRank(value: number | "unlimited" | undefined): number {
  if (value === "unlimited") return Number.POSITIVE_INFINITY
  return typeof value === "number" ? value : Number.NaN
}

/**
 * True when a Free account that hit `key` gets more of it on Pro: a feature
 * that Pro has and Free does not, or a limit that is higher on Pro. Only the
 * Free plan qualifies, so a Pro account at a Pro limit keeps the plan limit
 * dialog. An unknown key or plan is false.
 */
export function proTrialUnlocks(plan: string | null, key: string): boolean {
  if (plan !== "free") return false
  const free = catalogPlan("free")
  const pro = catalogPlan("pro")
  if (!free || !pro || !DOXA_CATALOG.plans.pro.trial) return false
  // Pro on the Free team that the refusal names frees a Free team slot.
  if (key === FREE_TEAMS_PER_OWNER_KEY) return true
  const features = pro.features as Readonly<Record<string, boolean>>
  const freeFeatures = free.features as Readonly<Record<string, boolean>>
  if (key in features) return features[key] === true && freeFeatures[key] !== true
  const limits = pro.limits as Readonly<Record<string, number | "unlimited">>
  const freeLimits = free.limits as Readonly<Record<string, number | "unlimited">>
  if (!(key in limits)) return false
  return limitRank(limits[key]) > limitRank(freeLimits[key])
}

/**
 * The reason line of the Pro trial dialog for a 403 `plan_limit` that Pro
 * unlocks: "Doxabot needs Pro.", or the limit sentence and what Pro has
 * ("You use 1 of 1 custom domains on Free. Pro has 4.", or "Pro has no limit.").
 * `accountName` is the team name of the refused account, when the dashboard knows it.
 */
export function proTrialLimitReason(details: PlanLimitErrorDetails, plan: string, accountName?: string | null): string {
  if (details.key === FREE_TEAMS_PER_OWNER_KEY) {
    const limit = freeTeamsLimitPhrase(details.limit)
    return accountName
      ? `Each person can own ${limit}, and you own "${accountName}". Upgrade "${accountName}" to Pro to create more teams.`
      : `Each person can own ${limit}. Upgrade your Free team to Pro to create more teams.`
  }
  if (typeof details.limit === "boolean") {
    if (details.key === "ai.doxa_agent") return "Generating docs needs Pro."
    return `${FEATURE_LABELS[details.key] ?? "This feature"} needs Pro.`
  }
  const proLimit = (catalogPlan("pro")?.limits as Readonly<Record<string, number | "unlimited">> | undefined)?.[details.key]
  const sentence = planLimitSentence({ ...details, plan })
  if (proLimit === undefined) return `${sentence} Pro raises the limit.`
  if (proLimit === "unlimited") return `${sentence} Pro has no limit.`
  return `${sentence} Pro has ${formatLimitNumber(details.key, proLimit)}.`
}
