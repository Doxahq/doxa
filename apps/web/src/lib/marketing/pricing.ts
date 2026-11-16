// Copy for the pricing page. Bracketed values are placeholders for limits
// that are not decided yet. Prices, credits and pay-as-you-go come from the
// billing catalog (`@doxahq/billing/catalog`), so the page and Checkout
// always agree.

import { DOXA_CATALOG, describeOffer, formatUsd, isUnlimited, type LimitKey, type OfferView } from "@doxahq/billing/catalog"

/** A run of text; `ph` marks a placeholder that renders in the `.ph` style. */
export type Rich = string | { ph: string }

export type PlanAction = "start" | "upgrade" | "contact"

export type BillingPeriod = "monthly" | "yearly"

/** The price, unit and line under it for one billing period. */
export interface PlanPricing {
  price: Rich
  per?: string
  sub: string
}

export const FOUNDER_OFFER_KEY = "founder_v1"

/** The founder offer as a new Checkout prices it with every spot open: what the prerendered page shows. */
export const DEFAULT_PRO_OFFER: OfferView = describeOffer(DOXA_CATALOG, FOUNDER_OFFER_KEY, 0)

/** The Checkout interval of a billing period. */
export const PERIOD_INTERVAL: Record<BillingPeriod, "month" | "year"> = { monthly: "month", yearly: "year" }

/** The parts of an offer that set the Pro price lines: the catalog view or `GET /billing/offers`. */
export interface OfferPrices {
  prices: Record<"month" | "year", { amountCents: number; monthlyEquivalentCents: number }>
  yearlySavingsPercent: number
}

/** The Pro price for each billing period, from an offer. */
export function proPricing(offer: OfferPrices): Record<BillingPeriod, PlanPricing> {
  const { month, year } = offer.prices
  return {
    monthly: { price: formatUsd(month.amountCents), per: "/ month", sub: "Billed monthly · cancel anytime" },
    yearly: {
      price: formatUsd(year.monthlyEquivalentCents),
      per: "/ month",
      sub: `Billed yearly at ${formatUsd(year.amountCents)} · cancel anytime`,
    },
  }
}

/** Choices of the billing toggle on a plan card, in display order. */
export function billingOptions(offer: OfferPrices): { id: BillingPeriod; label: string; note?: string }[] {
  return [
    { id: "monthly", label: "Monthly" },
    { id: "yearly", label: "Yearly", ...(offer.yearlySavingsPercent > 0 ? { note: `−${offer.yearlySavingsPercent}%` } : {}) },
  ]
}

export const BILLING_OPTIONS = billingOptions(DEFAULT_PRO_OFFER)

export const DEFAULT_BILLING: BillingPeriod = "yearly"

/** The offer line under the Pro price. With the live offer, it counts the spots left (spec 7.5). */
export function founderOfferLine(offer: { open: boolean; slotsLeft: number; maxAccounts: number } | null): string | null {
  if (!offer) return `Founder price for the first ${DEFAULT_PRO_OFFER.maxAccounts} paying customers`
  if (!offer.open) return null
  return `${offer.slotsLeft} of ${offer.maxAccounts} founder spots left`
}

/**
 * "Upgrade to Pro": sign-in first, then the dashboard opens Checkout at this
 * interval (`/dashboard/billing?upgrade=`). A signed-in visitor goes on at once.
 */
export function upgradeUrl(period: BillingPeriod, signInUrl = "/login"): string {
  const next = `/dashboard/billing?upgrade=${PERIOD_INTERVAL[period]}`
  return `${signInUrl}?redirect=${encodeURIComponent(next)}`
}

/** "Founder price for the first 50 paying customers": the static note of the hero and the CTA bands. */
export const FOUNDER_PRICE_NOTE = founderOfferLine(null) ?? ""

const fmt = (value: number) => new Intl.NumberFormat("en-US").format(value)
const proCreditsLimit = DOXA_CATALOG.plans.pro.limits["ai.credits_monthly"]
/** 5,000: the Pro allowance. */
export const PRO_MONTHLY_CREDITS = typeof proCreditsLimit === "number" ? proCreditsLimit : 0
const generationPricing = DOXA_CATALOG.actions["generation.run"].pricing
const doxabotPricing = DOXA_CATALOG.actions["doxabot.run"].pricing
const creditCents = DOXA_CATALOG.credit.unitPriceCents
/** "$0.01". */
export const CREDIT_PRICE = formatUsd(creditCents, { cents: true })
/** Decision D10: docs chat launches later, so the page hides every chat line while it is planned. */
const docsChatStatus: string = DOXA_CATALOG.actions["docs_chat.answer"].status
export const DOCS_CHAT_LIVE = docsChatStatus === "live"
const payg = DOXA_CATALOG.payg
const usd = (credits: number) => formatUsd(credits * creditCents)

/**
 * The first lines of the Pro card. The dashboard's Pro trial offer shows the
 * same lines, so both say the same thing about Pro.
 */
export const PRO_HIGHLIGHTS = {
  agent: "Doxa Agent writes docs from your GitHub repo",
  updates: "Keeps your docs updated with every PR or merge",
  credits: `${fmt(PRO_MONTHLY_CREDITS)} AI credits / month`,
  payg: `Pay-as-you-go above that, ${CREDIT_PRICE} per credit`,
} as const

const proLimits = DOXA_CATALOG.plans.pro.limits

/** "Unlimited team seats", or "4 team seats" when Pro has a number for the limit. */
function proLimitLine(key: LimitKey, noun: string): string {
  const limit = proLimits[key]
  return isUnlimited(limit) ? `Unlimited ${noun}` : `${fmt(limit)} ${noun}`
}

export interface ProFeatureGroup {
  readonly id: "ai" | "site_team"
  readonly label: string
  readonly items: readonly string[]
}

/**
 * The Pro features in two groups, for the trial dialog and the upgrade card.
 * The credit numbers and the limits come from the catalog.
 */
export const PRO_FEATURE_GROUPS: readonly ProFeatureGroup[] = [
  {
    id: "ai",
    label: "AI",
    items: [
      "Docs written from your repo",
      "Docs updated on every PR",
      `${fmt(PRO_MONTHLY_CREDITS)} AI credits a month`,
      `Then ${CREDIT_PRICE} per credit`,
    ],
  },
  {
    id: "site_team",
    label: "Site and team",
    items: [
      "Instant cloud search",
      proLimitLine("mcp.tool_calls_per_day", "MCP calls"),
      proLimitLine("docs.branches_per_site", "branches"),
      proLimitLine("team.seats", "team seats"),
    ],
  },
]

export interface Plan {
  id: "free" | "pro" | "enterprise"
  name: string
  desc: string
  /** A placeholder price renders as `.ph`. */
  price: Rich
  /** Shown after the price, e.g. "/ month". */
  per?: string
  sub: string
  /** A short line under the price, shown in the accent color, for an offer such as the founder price. */
  offer?: string
  /** A plan with this field shows a monthly / yearly toggle; it overrides `price`, `per` and `sub`. */
  billing?: Record<BillingPeriod, PlanPricing>
  includes: string
  checks: Rich[][]
  hosts: { label: string; lav?: boolean }[]
  cta: { label: string; className: string; action: PlanAction }
}

export const PLANS: Plan[] = [
  {
    id: "free",
    name: "FREE",
    desc: "For solo developers and open-source projects that write their own docs and want them hosted.",
    price: "$0",
    per: "/ month",
    sub: "No card needed",
    includes: "Included in Free:",
    checks: [
      ["Docs site with search and llms.txt"],
      ["3 branches per site with previews"],
      ["100 MB docs storage, 1 custom domain"],
      ["MCP server, 100 tool calls / day"],
    ],
    hosts: [{ label: "SHARED HOSTING" }, { label: "\"POWERED BY DOXA\" BADGE" }],
    cta: { label: "Start free ›", className: "btn btn--line", action: "start" },
  },
  {
    id: "pro",
    name: "PRO",
    desc: "For product teams that ship every week and want docs on their own brand.",
    ...proPricing(DEFAULT_PRO_OFFER).yearly,
    billing: proPricing(DEFAULT_PRO_OFFER),
    offer: founderOfferLine(null) ?? undefined,
    includes: "Everything in Free, plus:",
    checks: [
      [PRO_HIGHLIGHTS.agent],
      [PRO_HIGHLIGHTS.updates],
      ...(DOCS_CHAT_LIVE ? [["AI chat on your docs site"]] : []),
      [PRO_HIGHLIGHTS.credits],
      [PRO_HIGHLIGHTS.payg],
      ["Invite your team, unlimited seats"],
      ["Role-based permissions for every member"],
      ["Remove the \"Powered by Doxa\" badge"],
      ["Unlimited branches per site with previews"],
      ["Unlimited docs storage"],
      ["4 custom domains"],
      ["Unlimited MCP tool calls"],
    ],
    hosts: [{ label: "DEDICATED HOSTING" }, { label: "YOUR BRAND" }],
    cta: { label: "Upgrade to Pro ›", className: "btn btn--blue", action: "upgrade" },
  },
  {
    id: "enterprise",
    name: "ENTERPRISE",
    desc: "For organizations with many products, many repos and their own review rules.",
    price: "Custom",
    sub: "Volume pricing available",
    includes: "Everything in Pro, plus:",
    checks: [
      ["50,000+ AI credits / month at volume pricing"],
      ["Unlimited custom domains"],
      ["Approval rules for agents and MCP clients"],
      ["Onboarding with the Doxa team"],
      ["Custom features + full support"],
      ["Security and legal review"],
      ["Custom SLA"],
    ],
    hosts: [{ label: "DEDICATED HOSTING + CUSTOM SUPPORT" }, { label: "SELF-HOSTED · OPEN SOURCE", lav: true }],
    cta: { label: "Talk to us ›", className: "btn btn--light", action: "contact" },
  },
]

/** One comparison cell: a check, a dash, a value or a placeholder. */
export type CompareCell = { t: string; cls: "" | "yes" | "no" | "ph" }

export type CompareRow =
  | { kind: "group"; label: string }
  | { kind: "item"; label: string; free: CompareCell; pro: CompareCell; enterprise: CompareCell }

const yes: CompareCell = { t: "✓", cls: "yes" }
const no: CompareCell = { t: "—", cls: "no" }
const v = (t: string): CompareCell => ({ t, cls: "" })
const group = (label: string): CompareRow => ({ kind: "group", label })
const item = (label: string, free: CompareCell, pro: CompareCell, enterprise: CompareCell): CompareRow => ({
  kind: "item",
  label,
  free,
  pro,
  enterprise,
})

/** Decision D21: a pull request run without a baseline analyzes the whole repository. */
export const COLD_RUN_NOTE = "A pull request run with no cache yet counts as a Full generation."

export const COMPARE_ROWS: CompareRow[] = [
  group("Doxa Agent"),
  item("Generate docs from a GitHub repo", no, yes, yes),
  item("Doxabot rewrites affected pages on every merge", no, yes, yes),
  item("Approval before every publish", no, yes, yes),
  group("AI credits"),
  item("AI credits per month", no, v(fmt(PRO_MONTHLY_CREDITS)), v("50,000+")),
  item("Full generation", no, v(`${generationPricing.base} + model usage`), v(`${generationPricing.base} + model usage`)),
  item("Update run (pull request or merge)", no, v(`${doxabotPricing.base} + model usage`), v(`${doxabotPricing.base} + model usage`)),
  item("Credits above the allowance", no, v(`Pay-as-you-go, ${CREDIT_PRICE} each`), v("Volume pricing")),
  group("Docs platform"),
  item("Hosted MDX docs site", yes, yes, yes),
  item("Search and llms.txt", yes, yes, yes),
  ...(DOCS_CHAT_LIVE ? [item("AI chat on your docs site", no, yes, yes)] : []),
  item("Branches per site with previews", v("3"), v("Unlimited"), v("Unlimited")),
  item("Docs storage", v("100 MB"), v("Unlimited"), v("Unlimited")),
  item("Custom domains", v("1"), v("4"), v("Unlimited")),
  item("Remove \"Powered by Doxa\"", no, yes, yes),
  group("Agents & tools"),
  item("MCP server for Claude, Cursor, Codex", yes, yes, yes),
  item("MCP tool calls per day", v("100"), v("Unlimited"), v("Unlimited")),
  group("Team"),
  item("Team seats", v("Owner only"), v("Unlimited"), v("Unlimited")),
  item("Role-based permissions", no, yes, yes),
  item("Onboarding with the Doxa team", no, no, yes),
  item("Custom features + full support", no, no, yes),
  group("Security"),
  item("Security and legal review", no, no, yes),
  item("Custom SLA", no, no, yes),
]

export interface FaqItem {
  q: string
  a: Rich[]
}

export const FAQ: FaqItem[] = [
  {
    q: "Is the Free plan really free?",
    a: [
      "Yes. The Free plan costs $0 and includes a docs site on shared hosting, and the MCP server, with 3 branches per site, 100 MB of docs storage and 1 custom domain. Free is for one owner. Team access, the Doxa Agent and Doxabot come with Pro.",
    ],
  },
  {
    q: "What does the \"Powered by Doxa\" badge mean?",
    a: [
      "Docs sites on the Free plan show a small \"Powered by Doxa\" mark. Paid plans let you turn it off in Site settings › Branding.",
    ],
  },
  {
    q: "Does anything publish without my approval?",
    a: [
      "Not on Pro and Enterprise. There, the agent and MCP clients write to a branch with a preview, and nothing goes live until you approve the publish.",
    ],
  },
  {
    q: "How do AI credits work?",
    a: [
      `AI credits come with Pro and Enterprise. Pro includes ${fmt(PRO_MONTHLY_CREDITS)} credits each month, and 1 credit is worth ${CREDIT_PRICE}. An AI action costs a base fee plus the AI model usage of the run: a Full generation costs ${generationPricing.base} credits plus usage (about 266–350 credits for 50 pages), and an Update run (pull request or merge) costs ${doxabotPricing.base} credits plus usage. ${COLD_RUN_NOTE} Before a run, the dashboard shows an estimate, and each run stops at a cap that you set. A failed action costs nothing, and an Update run that changes nothing pays only its usage. MCP tool calls, hosting and previews never use credits.`,
    ],
  },
  {
    q: "What happens when I run out of credits?",
    a: [
      `On Pro, runs continue with pay-as-you-go at ${CREDIT_PRICE} per credit. Doxa charges your card automatically when the balance reaches ${usd(payg.chargeAtCredits)}, and once a month. A monthly limit (${formatUsd(payg.defaultMonthlyLimitCents)} by default, from ${formatUsd(payg.monthlyLimitRangeCents[0])} to ${formatUsd(payg.monthlyLimitRangeCents[1])}) keeps the total in check, and you can turn pay-as-you-go off. During the trial, AI runs pause when the trial credits run out. Your docs site always stays online. Monthly credits expire at the end of the month.`,
    ],
  },
  {
    q: "What counts as a branch?",
    a: [
      "Each docs site has a main branch and working branches for changes, agent rewrites and previews. The branch limit counts the working branches of one site.",
    ],
  },
  {
    q: "Is Doxa open source?",
    a: ["Yes. Doxa is an open-source platform. Enterprise plans can talk to us about self-hosting."],
  },
  {
    q: "Am I locked in to Doxa?",
    a: [
      "No. Your pages are plain MDX, not a closed format. You can download every page, image and setting in one archive and leave at any time. Doxa is open source, so you can also run the full platform on your own servers.",
    ],
  },
  {
    q: "What is the founder price?",
    a: [
      `The Pro prices on this page are a founder price for our first ${DEFAULT_PRO_OFFER.maxAccounts} paying customers. A founder keeps the price while the subscription stays active, also after a switch between monthly and yearly. After that, Pro prices go up for new customers. Pay-as-you-go credits cost ${CREDIT_PRICE} each on every plan.`,
    ],
  },
]
