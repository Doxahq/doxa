// Copy for the pricing page. Bracketed values are placeholders for limits
// that are not decided yet.

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

/** Choices of the billing toggle on a plan card, in display order. */
export const BILLING_OPTIONS: { id: BillingPeriod; label: string; note?: string }[] = [
  { id: "monthly", label: "Monthly" },
  { id: "yearly", label: "Yearly", note: "−17%" },
]

export const DEFAULT_BILLING: BillingPeriod = "yearly"

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
    price: "$149",
    per: "/ month",
    sub: "Billed yearly at $1,788 · cancel anytime",
    billing: {
      monthly: { price: "$179", per: "/ month", sub: "Billed monthly · cancel anytime" },
      yearly: { price: "$149", per: "/ month", sub: "Billed yearly at $1,788 · cancel anytime" },
    },
    offer: "Special price for the first 100 customers",
    includes: "Everything in Free, plus:",
    checks: [
      ["Doxa Agent writes docs from your GitHub repo"],
      ["Keeps your docs updated with every PR or merge"],
      ["AI chat on your docs site"],
      ["10,000 AI credits / month"],
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

export const COMPARE_ROWS: CompareRow[] = [
  group("Doxa Agent"),
  item("Generate docs from a GitHub repo", no, yes, yes),
  item("Doxabot rewrites affected pages on every merge", no, yes, yes),
  item("Approval before every publish", no, yes, yes),
  group("AI credits"),
  item("AI credits per month", no, v("10,000"), v("50,000+")),
  item("Docs chat answer", no, v("10 credits"), v("10 credits")),
  item("Docs generation from a repo", no, v("100 + 5 per page"), v("100 + 5 per page")),
  item("Doxabot run that changes pages", no, v("100 credits"), v("100 credits")),
  item("Extra credits", no, v("Packs (pay-as-you-go coming soon)"), v("Volume pricing")),
  group("Docs platform"),
  item("Hosted MDX docs site", yes, yes, yes),
  item("Search and llms.txt", yes, yes, yes),
  item("AI chat on your docs site", no, yes, yes),
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
      "AI credits come with Pro and Enterprise. Every AI action uses credits from one monthly pool, and 1 credit is worth $0.01. A docs chat answer uses 10 credits, a docs generation uses 100 credits plus 5 per page, and a Doxabot run that changes pages uses 100 credits. The first generation of each new site is free. An action that fails, a chat question without an answer and a Doxabot run that changes nothing use no credits. MCP tool calls, hosting and previews never use credits.",
    ],
  },
  {
    q: "What happens when I run out of credits?",
    a: [
      "Only the AI features pause until the next month. Your docs site stays online. On Pro you can buy extra credits: 5,000 for $50, 20,000 for $180 or 50,000 for $400. Monthly credits expire at the end of the month, and extra credits stay valid for 12 months.",
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
      "The Pro prices on this page are a special founder price for our first 100 customers. After that, Pro prices go up for new customers. The founder price does not apply to extra AI credit packs.",
    ],
  },
]
