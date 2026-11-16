import { createFileRoute } from "@tanstack/react-router"

import { BillingAccountsPage } from "~/components/dashboard/billing/billing-accounts-page"
import { dashboardPendingView } from "~/components/dashboard/pending-view"
import { projectPagePending } from "~/components/dashboard/route-pending"

interface BillingSearch {
  /** Set by the pricing page's "Upgrade to Pro": go on to Checkout at this interval. */
  upgrade?: "month" | "year"
}

export const Route = createFileRoute("/dashboard/billing/")({
  validateSearch: (search: Record<string, unknown>): BillingSearch =>
    search.upgrade === "month" || search.upgrade === "year" ? { upgrade: search.upgrade } : {},
  ...projectPagePending,
  pendingComponent: dashboardPendingView("billingAccount"),
  component: BillingRoute,
})

function BillingRoute() {
  const { upgrade } = Route.useSearch()
  return <BillingAccountsPage upgradeInterval={upgrade ?? null} />
}
