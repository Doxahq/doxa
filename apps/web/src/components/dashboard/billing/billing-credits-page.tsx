import { useInfiniteQuery } from "@tanstack/react-query"

import { BillingCreditsView } from "~/components/dashboard/billing/billing-credits-view"
import { BillingPageSwitching } from "~/components/dashboard/billing/billing-page-layout"
import { BillingUnavailable } from "~/components/dashboard/billing/billing-unavailable"
import { BillingCreditsSkeleton } from "~/components/dashboard/skeletons/billing-skeletons"
import { creditHistoryRows } from "~/lib/dashboard/billing-model"
import { useBillingAccountActions, useBillingAccountQueries } from "~/lib/dashboard/use-billing-account"
import { useLoadPhase } from "~/lib/dashboard/use-first-load"
import { morePagesOf } from "~/lib/dashboard/use-revealed-rows"
import { billingInvoicesQueryOptions, billingLedgerEntriesQueryOptions } from "~/lib/queries/billing"

/** `/dashboard/billing/<accountId>/credits`: AI credits (billing spec 15.2). */
export function BillingCreditsPage({ accountId }: { accountId: string }) {
  const { detailQuery, accountsQuery } = useBillingAccountQueries(accountId)
  const ready = detailQuery.isSuccess
  // The pay-as-you-go card lists the usage charges, so this page reads the invoices too.
  const invoicesQuery = useInfiniteQuery({ ...billingInvoicesQueryOptions(accountId), enabled: ready })
  const entriesQuery = useInfiniteQuery({ ...billingLedgerEntriesQueryOptions(accountId), enabled: ready })
  const actions = useBillingAccountActions(accountId)

  const loadPhase = useLoadPhase(
    [
      detailQuery,
      accountsQuery,
      { isPending: ready && invoicesQuery.isPending },
      { isPending: ready && entriesQuery.isPending },
    ],
    accountId,
  )
  if (loadPhase === "first") return <BillingCreditsSkeleton />
  if (loadPhase === "switching") {
    return <BillingPageSwitching page="credits" accountId={accountId} accounts={accountsQuery.data?.accounts ?? []} />
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

  return (
    <BillingCreditsView
      detail={detail}
      invoices={invoicesQuery.data?.pages.flatMap((page) => page.invoices) ?? []}
      historyRows={creditHistoryRows(entriesQuery.data?.pages.flatMap((page) => page.entries) ?? [])}
      historyPages={morePagesOf(entriesQuery)}
      actions={{
        payg: {
          onChange: (input) => actions.payg.mutateAsync(input),
          isPending: actions.payg.isPending,
          error: actions.errorOf(actions.payg, "Could not save pay-as-you-go."),
        },
        caps: {
          onSave: (action, capCredits) => actions.cap.mutateAsync({ action, capCredits }),
          isPending: actions.cap.isPending,
          error: actions.errorOf(actions.cap, "Could not save the cap."),
        },
      }}
    />
  )
}
