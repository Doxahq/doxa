import { useCallback } from "react"
import { createFileRoute } from "@tanstack/react-router"

import { BillingAccountPage } from "~/components/dashboard/billing/billing-account-page"
import { dashboardPendingView } from "~/components/dashboard/pending-view"
import { projectPagePending } from "~/components/dashboard/route-pending"

interface BillingAccountSearch {
  /** The Checkout return (billing spec 14.2): the session to sync. */
  checkout?: string
}

export const Route = createFileRoute("/dashboard/billing/$accountId/")({
  validateSearch: (search: Record<string, unknown>): BillingAccountSearch =>
    typeof search.checkout === "string" ? { checkout: search.checkout } : {},
  // The page skeleton, not a spinner: one loading state per visit.
  ...projectPagePending,
  pendingComponent: dashboardPendingView("billingAccount"),
  component: BillingAccountRoute,
})

function BillingAccountRoute() {
  const { accountId } = Route.useParams()
  const { checkout } = Route.useSearch()
  const navigate = Route.useNavigate()
  const clearCheckout = useCallback(() => {
    void navigate({ search: {}, replace: true })
  }, [navigate])
  return <BillingAccountPage accountId={accountId} checkoutSessionId={checkout ?? null} onCheckoutHandled={clearCheckout} />
}
