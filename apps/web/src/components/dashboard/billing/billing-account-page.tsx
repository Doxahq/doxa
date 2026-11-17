import { useState } from "react"
import { useInfiniteQuery } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"

import { BillingAccountView } from "~/components/dashboard/billing/billing-account-view"
import { BillingPageSwitching } from "~/components/dashboard/billing/billing-page-layout"
import { BillingUnavailable } from "~/components/dashboard/billing/billing-unavailable"
import { OfferClosedDialog } from "~/components/dashboard/billing/offer-closed-dialog"
import { BillingAccountSkeleton } from "~/components/dashboard/skeletons/billing-skeletons"
import { offerClosedPrice } from "~/lib/dashboard/offer-closed"
import { useBillingAccountActions, useBillingAccountQueries } from "~/lib/dashboard/use-billing-account"
import { useCheckoutReturn } from "~/lib/dashboard/use-checkout-return"
import { useLoadPhase } from "~/lib/dashboard/use-first-load"
import { morePagesOf } from "~/lib/dashboard/use-revealed-rows"
import { billingInvoicesQueryOptions } from "~/lib/queries/billing"

/** `/dashboard/billing/<accountId>`: Plan and invoices (billing spec 15.2). */
export function BillingAccountPage({
  accountId,
  checkoutSessionId,
  onCheckoutHandled,
}: {
  accountId: string
  /** `?checkout=<id>` of the Checkout return. */
  checkoutSessionId: string | null
  onCheckoutHandled: () => void
}) {
  const { detailQuery, accountsQuery } = useBillingAccountQueries(accountId)
  const invoicesQuery = useInfiniteQuery({ ...billingInvoicesQueryOptions(accountId), enabled: detailQuery.isSuccess })
  const actions = useBillingAccountActions(accountId)
  // The Checkout return syncs once, then drops the parameter from the URL.
  const sync = useCheckoutReturn(checkoutSessionId, onCheckoutHandled)
  const [closedOffer, setClosedOffer] = useState<{ priceKey: string } | null>(null)

  const loadPhase = useLoadPhase(
    [detailQuery, accountsQuery, { isPending: detailQuery.isSuccess && invoicesQuery.isPending }],
    accountId,
  )
  if (loadPhase === "first") return <BillingAccountSkeleton />
  if (loadPhase === "switching") {
    return <BillingPageSwitching page="plan" accountId={accountId} accounts={accountsQuery.data?.accounts ?? []} />
  }

  const detail = detailQuery.data
  if (!detail) {
    return (
      <BillingUnavailable
        error={detailQuery.error}
        scope="account"
        onRetry={() => void detailQuery.refetch()}
        isRetrying={detailQuery.isFetching}
      />
    )
  }

  function upgrade(priceKey: string): void {
    actions.checkout.mutate(priceKey, {
      onError: (error) => {
        const price = offerClosedPrice(error)
        if (price) setClosedOffer({ priceKey: price })
      },
    })
  }

  const notice = sync.isPending ? (
    <p role="status" className="flex items-center gap-2 border border-border bg-secondary px-4 py-3 text-[13px] text-body">
      <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      Updating your plan from Stripe…
    </p>
  ) : sync.isSuccess ? (
    <p role="status" className="border border-success/35 bg-success/8 px-4 py-3 text-[13px] text-foreground">
      Thanks. Your plan is up to date.
    </p>
  ) : null
  const portalError = actions.errorOf(actions.portal, "Could not open Stripe.")

  return (
    <>
      <BillingAccountView
        detail={detail}
        invoices={invoicesQuery.data?.pages.flatMap((page) => page.invoices) ?? []}
        invoicePages={morePagesOf(invoicesQuery)}
        notice={notice}
        actions={{
          plan: {
            onCancel: () => actions.portal.mutate("subscription_cancel"),
            onManage: () => actions.portal.mutate(undefined),
            isPortalPending: actions.portal.isPending,
            portalError,
            onSwitchInterval: (interval, idempotencyKey) => actions.planInterval.mutateAsync({ interval, idempotencyKey }),
            isSwitchPending: actions.planInterval.isPending,
            switchError: actions.errorOf(actions.planInterval, "Could not change the billing period."),
          },
          upgrade: {
            onUpgrade: upgrade,
            isPending: actions.checkout.isPending,
            error: closedOffer ? null : actions.errorOf(actions.checkout, "Could not open Checkout."),
          },
          updateCard: {
            onUpdateCard: () => actions.portal.mutate("payment_method_update"),
            isPending: actions.portal.isPending,
            error: portalError,
          },
        }}
      />
      <OfferClosedDialog
        priceKey={closedOffer?.priceKey ?? null}
        isPending={actions.checkout.isPending}
        onCancel={() => setClosedOffer(null)}
        onAccept={(priceKey) => {
          setClosedOffer(null)
          actions.checkout.mutate(priceKey)
        }}
      />
    </>
  )
}
