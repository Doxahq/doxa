import { createFileRoute } from "@tanstack/react-router"

import { BillingCreditsPage } from "~/components/dashboard/billing/billing-credits-page"
import { dashboardPendingView } from "~/components/dashboard/pending-view"
import { projectPagePending } from "~/components/dashboard/route-pending"

export const Route = createFileRoute("/dashboard/billing/$accountId/credits")({
  // The page skeleton, not a spinner: one loading state per visit.
  ...projectPagePending,
  pendingComponent: dashboardPendingView("billingCredits"),
  component: BillingCreditsRoute,
})

function BillingCreditsRoute() {
  const { accountId } = Route.useParams()
  return <BillingCreditsPage accountId={accountId} />
}
