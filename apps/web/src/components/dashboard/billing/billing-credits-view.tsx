import { Link } from "@tanstack/react-router"
import { Coins } from "lucide-react"
import type { BillingAccountDetail, BillingInvoice } from "@doxahq/contracts/billing"

import { EmptyState } from "~/components/dashboard/dashboard-header"
import { BillingCapsSection, type CapsSectionActions } from "~/components/dashboard/billing/billing-caps-section"
import { BillingCreditHistory } from "~/components/dashboard/billing/billing-credit-history"
import { BillingCreditsSection } from "~/components/dashboard/billing/billing-credits-section"
import { BillingPageLayout } from "~/components/dashboard/billing/billing-page-layout"
import { BillingPaygCard, type PaygCardActions } from "~/components/dashboard/billing/billing-payg-card"
import { Button } from "~/components/ui/button"
import { hasLiveSubscription, type CreditHistoryRow } from "~/lib/dashboard/billing-model"
import { hasAiCredits } from "~/lib/dashboard/billing-plan-view"
import type { MorePages } from "~/lib/dashboard/use-revealed-rows"

export interface CreditsViewActions {
  payg: PaygCardActions
  caps: CapsSectionActions
}

/**
 * AI credits (frame "Account credits"): this month's credits, pay-as-you-go,
 * the cap of each run, and the credit history. The page component owns the
 * queries.
 */
export function BillingCreditsView({
  detail,
  invoices,
  historyRows,
  historyPages,
  actions,
}: {
  detail: BillingAccountDetail
  /** The pay-as-you-go card lists the paid usage charges and the unpaid one. */
  invoices: readonly BillingInvoice[]
  historyRows: readonly CreditHistoryRow[]
  historyPages: MorePages
  actions: CreditsViewActions
}) {
  const hasAi = hasAiCredits(detail)
  const showPayg = hasLiveSubscription(detail) || detail.entitlements.features["ai.payg"] === true

  return (
    <BillingPageLayout page="credits" detail={detail}>
      {hasAi ? (
        <BillingCreditsSection detail={detail} />
      ) : (
        <EmptyState
          className="max-w-none"
          icon={<Coins />}
          title="No AI credits on this plan"
          description="Full generations and update runs need Pro. A Pro trial comes with credits to start."
          action={
            <Button variant="outline" size="sm" asChild>
              <Link to="/dashboard/billing/$accountId" params={{ accountId: detail.id }}>
                Plan and invoices
              </Link>
            </Button>
          }
        />
      )}
      {showPayg ? <BillingPaygCard detail={detail} invoices={invoices} actions={actions.payg} /> : null}
      {hasAi ? <BillingCapsSection detail={detail} actions={actions.caps} /> : null}
      <BillingCreditHistory rows={historyRows} pages={historyPages} />
    </BillingPageLayout>
  )
}
