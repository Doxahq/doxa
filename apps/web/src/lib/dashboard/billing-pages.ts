/**
 * The two billing pages of an account. This module has no imports, so route
 * pending views (skeletons) can read the page copy without a page module.
 */
export type BillingPage = "plan" | "credits"

export const BILLING_PAGE_TITLES: Record<BillingPage, string> = {
  plan: "Plan and invoices",
  credits: "AI credits",
}

/** The account name in a sentence: "your personal account", or the team name. */
export function billingAccountPhrase(account: { ownerKind: "user" | "team"; name: string | null }): string {
  return account.ownerKind === "user" ? "your personal account" : (account.name ?? "this team account")
}

export function billingPageDescription(page: BillingPage, account: { ownerKind: "user" | "team"; name: string | null }): string {
  return page === "plan"
    ? `The plan of ${billingAccountPhrase(account)}, the card Stripe charges, and every invoice.`
    : "What AI runs use, how they continue past the monthly credits, and where every credit went."
}

/** The breadcrumb after "Account": "Billing / Plan and invoices". */
export function billingPageCrumbs(page: BillingPage): readonly string[] {
  return ["Billing", BILLING_PAGE_TITLES[page]]
}
