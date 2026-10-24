// Copy for the pricing page. Bracketed values are placeholders until the
// real prices and limits are decided.

/** A run of text; `ph` marks a placeholder that renders in the `.ph` style. */
export type Rich = string | { ph: string }

export type PlanAction = "start" | "upgrade" | "contact"

export interface Plan {
  id: "free" | "pro" | "enterprise"
  name: string
  desc: string
  /** A placeholder price renders as `.ph`. */
  price: Rich
  /** Shown after the price, e.g. "/ month". */
  per?: string
  sub: string
  includes: string
  checks: Rich[][]
  hosts: { label: string; lav?: boolean }[]
  cta: { label: string; className: string; action: PlanAction }
}

export const PLANS: Plan[] = [
  {
    id: "free",
    name: "FREE",
    desc: "For solo developers and open-source projects that want docs which keep up.",
    price: "$0",
    per: "/ month",
    sub: "No card needed",
    includes: "Included in Free:",
    checks: [
      ["Doxa Agent writes docs from your GitHub repo"],
      ["Pages rewritten on every merge, with your approval"],
      ["Hosted docs site with search, AI chat and llms.txt"],
      ["10 branches per site with previews"],
      ["100 MB docs storage, 1 custom domain"],
      ["MCP server and Doxa CLI"],
    ],
    hosts: [{ label: "DOXA CLOUD" }, { label: "\"POWERED BY DOXA\" BADGE" }],
    cta: { label: "Start free ›", className: "btn btn--line", action: "start" },
  },
  {
    id: "pro",
    name: "PRO",
    desc: "For product teams that ship every week and want docs on their own brand.",
    price: { ph: "[PRICE]" },
    per: "/ month",
    sub: "Billed monthly · cancel anytime",
    includes: "Everything in Free, plus:",
    checks: [
      ["Remove the \"Powered by Doxa\" badge"],
      [{ ph: "[LIMIT]" }, " branches per site"],
      [{ ph: "[LIMIT]" }, " docs storage"],
      [{ ph: "[LIMIT]" }, " custom domains"],
      ["Invite your team, ", { ph: "[SEATS]" }, " seats"],
    ],
    hosts: [{ label: "DOXA CLOUD" }, { label: "YOUR BRAND" }],
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
      ["Custom branch, storage and domain limits"],
      ["Approval rules for agents and MCP clients"],
      ["Onboarding with the Doxa team"],
      [{ ph: "[ENTERPRISE FEATURE]" }],
      [{ ph: "[ENTERPRISE FEATURE]" }],
    ],
    hosts: [{ label: "DOXA CLOUD" }, { label: "SELF-HOSTED · OPEN SOURCE", lav: true }],
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
const ph = (t: string): CompareCell => ({ t, cls: "ph" })
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
  item("Generate docs from a GitHub repo", yes, yes, yes),
  item("Rewrite affected pages on every merge", yes, yes, yes),
  item("Approval before every publish", yes, yes, yes),
  group("Docs platform"),
  item("Hosted MDX docs site", yes, yes, yes),
  item("Search, AI chat and llms.txt", yes, yes, yes),
  item("Branches per site", v("10"), ph("[LIMIT]"), v("Custom")),
  item("Docs storage", v("100 MB"), ph("[LIMIT]"), v("Custom")),
  item("Custom domains", v("1"), ph("[LIMIT]"), v("Custom")),
  item("Remove \"Powered by Doxa\"", no, yes, yes),
  group("Agents & tools"),
  item("MCP server for Claude, Cursor, Codex", yes, yes, yes),
  item("Doxa CLI", yes, yes, yes),
  group("Team"),
  item("Team seats", ph("[SEATS]"), ph("[SEATS]"), v("Custom")),
  item("Onboarding with the Doxa team", no, no, yes),
]

export interface FaqItem {
  q: string
  a: Rich[]
}

export const FAQ: FaqItem[] = [
  {
    q: "Is the Free plan really free?",
    a: [
      "Yes. The Free plan costs $0 and includes the Doxa Agent, a hosted docs site, the MCP server and the CLI, with 10 branches per site, 100 MB of docs storage and 1 custom domain.",
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
    a: ["No. The agent and MCP clients write to a branch with a preview. Nothing goes live until you approve the publish."],
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
    q: "How does the founder's discount work?",
    a: ["Early signups get a discount on paid plans. ", { ph: "[DISCOUNT DETAILS]" }],
  },
]
