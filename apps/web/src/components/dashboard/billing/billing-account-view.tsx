import type { ReactNode } from "react"
import type { BillingAccountDetail, BillingInvoice } from "@doxahq/contracts/billing"

import { BillingCreditsSummaryRow } from "~/components/dashboard/billing/billing-credits-summary-row"
import { BillingInvoicesSection } from "~/components/dashboard/billing/billing-invoices-section"
import { BillingPageLayout } from "~/components/dashboard/billing/billing-page-layout"
import { BillingPastDueBanner } from "~/components/dashboard/billing/billing-past-due-banner"
import { BillingPaymentMethodSection, type PaymentMethodActions } from "~/components/dashboard/billing/billing-payment-method-section"
import { BillingPlanLimits } from "~/components/dashboard/billing/billing-plan-limits"
import { BillingPlanSection, type PlanSectionActions } from "~/components/dashboard/billing/billing-plan-section"
import { BillingUpgradeCard } from "~/components/dashboard/billing/billing-upgrade-card"
import { founderOffer, hasLiveSubscription, isPastDue } from "~/lib/dashboard/billing-model"
import { hasAiCredits } from "~/lib/dashboard/billing-plan-view"
import type { MorePages } from "~/lib/dashboard/use-revealed-rows"

export interface BillingViewActions {
  plan: PlanSectionActions
  upgrade: { onUpgrade: (priceKey: string) => void; isPending: boolean; error: string | null }
  updateCard: PaymentMethodActions
}

/**
 * Plan and invoices (frames "Plan and invoices": Free, trial, Pro, past due),
 * from loaded data. The page component owns the queries.
 */
export function BillingAccountView({
  detail,
  invoices,
  invoicePages,
  actions,
  notice,
}: {
  detail: BillingAccountDetail
  invoices: readonly BillingInvoice[]
  invoicePages: MorePages
  actions: BillingViewActions
  /** A line above the sections, for example after the Checkout return. */
  notice?: ReactNode
}) {
  const offer = hasLiveSubscription(detail) ? null : founderOffer(detail.offers)
  const trialing = detail.subscription?.status === "trialing"
  const banner = isPastDue(detail) ? (
    <BillingPastDueBanner
      canManage={detail.canManage}
      isPending={actions.updateCard.isPending}
      error={actions.updateCard.error}
      onUpdateCard={actions.updateCard.onUpdateCard}
    />
  ) : null

  return (
    <BillingPageLayout page="plan" detail={detail} banner={banner}>
      {notice}
      <BillingPlanSection detail={detail} actions={actions.plan} />
      {offer ? (
        <BillingUpgradeCard
          offer={offer}
          canManage={detail.canManage}
          trialAvailable={detail.trialAvailable}
          isPending={actions.upgrade.isPending}
          error={actions.upgrade.error}
          onUpgrade={actions.upgrade.onUpgrade}
        />
      ) : null}
      {offer ? <BillingPlanLimits detail={detail} /> : null}
      {detail.subscription ? <BillingPaymentMethodSection detail={detail} actions={actions.updateCard} /> : null}
      {hasAiCredits(detail) ? <BillingCreditsSummaryRow detail={detail} /> : null}
      <BillingInvoicesSection
        invoices={invoices}
        pages={invoicePages}
        emptyText={trialing ? "No invoices yet. The first one comes when the trial ends." : "No invoices yet."}
      />
    </BillingPageLayout>
  )
}
