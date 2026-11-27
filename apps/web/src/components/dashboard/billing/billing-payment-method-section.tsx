import { ExternalLink, Loader2 } from "lucide-react"
import type { BillingAccountDetail } from "@doxahq/contracts/billing"

import { SectionLabel } from "~/components/dashboard/dashboard-header"
import { CardBrandMark } from "~/components/dashboard/billing/card-brand-mark"
import { Button } from "~/components/ui/button"
import { REPLAY_MASK_PROPS } from "~/lib/analytics/replay-privacy"
import { paymentMethodView } from "~/lib/dashboard/billing-plan-view"
import { cn } from "~/lib/utils"

export interface PaymentMethodActions {
  onUpdateCard: () => void
  isPending: boolean
  error: string | null
}

/**
 * PAYMENT METHOD: the card Stripe charges ("Visa ending 4242 · Expires
 * 08/2029"), or "Managed in Stripe" when the API has no card to show (Link,
 * or a failed read). Both open the Portal's card update flow.
 */
export function BillingPaymentMethodSection({
  detail,
  actions,
}: {
  detail: BillingAccountDetail
  actions: PaymentMethodActions
}) {
  const view = paymentMethodView(detail)
  return (
    <section className="flex flex-col gap-3" aria-labelledby="billing-payment-method">
      <SectionLabel>
        <span id="billing-payment-method">Payment method</span>
      </SectionLabel>
      <div className="surface-card flex flex-wrap items-center gap-3.5 px-5 py-4">
        <CardBrandMark logo={view.logo} />
        <span {...REPLAY_MASK_PROPS} className="flex min-w-0 flex-[1_1_16rem] flex-col">
          <span className="text-[14.5px] text-foreground">{view.title}</span>
          <span className={cn("text-[13px]", view.isProblem ? "text-destructive" : "text-muted-foreground")}>{view.detail}</span>
        </span>
        {detail.canManage ? (
          <Button variant="outline" size="sm" disabled={actions.isPending} onClick={actions.onUpdateCard}>
            {actions.isPending ? (
              <Loader2 aria-hidden="true" className="animate-spin" />
            ) : (
              <ExternalLink aria-hidden="true" />
            )}
            Update in Stripe
          </Button>
        ) : null}
      </div>
      {actions.error ? <p className="text-[13px] text-destructive">{actions.error}</p> : null}
    </section>
  )
}
