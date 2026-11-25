import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Navigate } from "@tanstack/react-router"
import { Loader2 } from "lucide-react"
import type { BillingAccountSummary } from "@doxahq/contracts/billing"

import { PageBody, PageHeading, SectionLabel } from "~/components/dashboard/dashboard-header"
import { BillingAccountCards, billingAccountName } from "~/components/dashboard/billing/billing-account-cards"
import { BillingUnavailable } from "~/components/dashboard/billing/billing-unavailable"
import { OfferClosedDialog } from "~/components/dashboard/billing/offer-closed-dialog"
import { AccountTopBar } from "~/components/dashboard/shell/top-bar"
import { offerClosedPrice } from "~/lib/dashboard/offer-closed"
import { BillingAccountSkeleton, BillingAccountsSkeleton } from "~/components/dashboard/skeletons/billing-skeletons"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { captureBrowserEvent } from "~/lib/analytics/capture-browser-event"
import { createBillingCheckout } from "~/lib/billing-api"
import { founderOffer } from "~/lib/dashboard/billing-model"
import { openBillingUrl } from "~/lib/dashboard/use-billing-account"
import { useIsFirstLoad } from "~/lib/dashboard/use-first-load"
import { useWorkspace } from "~/lib/dashboard/workspace-context"
import { canReadBillingOf } from "~/lib/dashboard/workspace-model"
import { getErrorMessage } from "~/lib/errors"
import { billingAccountsQueryOptions, billingOffersQueryOptions } from "~/lib/queries/billing"

/**
 * `/dashboard/billing`: it opens Plan and invoices of the current workspace's
 * account, else of the one account the viewer manages, else it lists every
 * billing account. From the pricing page (`?upgrade=year`), it goes on to
 * Checkout: at once when only one account can upgrade, else after the person
 * picks one.
 */
export function BillingAccountsPage({ upgradeInterval }: { upgradeInterval: "month" | "year" | null }) {
  const accountsQuery = useQuery(billingAccountsQueryOptions())
  const { current } = useWorkspace()
  const offersQuery = useQuery({ ...billingOffersQueryOptions(), enabled: upgradeInterval !== null })
  const [closedPrice, setClosedPrice] = useState<{ accountId: string; priceKey: string } | null>(null)
  const checkout = useMutation({
    mutationFn: (input: { accountId: string; priceKey: string }) => createBillingCheckout(input.accountId, input.priceKey),
    onSuccess: openBillingUrl,
    onError: (error, input) => {
      const priceKey = offerClosedPrice(error)
      if (priceKey) setClosedPrice({ accountId: input.accountId, priceKey })
    },
  })

  const accounts = accountsQuery.data?.accounts ?? []
  const upgradable = accounts.filter((account) => account.canManage && account.plan === "free")
  const offer = founderOffer(offersQuery.data ?? [])
  const priceKey = upgradeInterval && offer ? offer.prices[upgradeInterval].priceKey : null

  // One account to upgrade: go on to Checkout with no extra click.
  const startedRef = useRef(false)
  const onlyAccount = upgradable.length === 1 ? upgradable[0] : null
  useEffect(() => {
    if (startedRef.current || !onlyAccount || !priceKey) return
    startedRef.current = true
    checkout.mutate({ accountId: onlyAccount.id, priceKey })
  }, [onlyAccount, priceKey, checkout])

  const isFirstLoad = useIsFirstLoad([
    accountsQuery,
    { isPending: upgradeInterval !== null && offersQuery.isPending },
    { isPending: upgradeInterval === null && current === null },
  ])
  // Most viewers have one account, so the page loads in the shape of its Plan and invoices.
  if (isFirstLoad) return upgradeInterval ? <BillingAccountsSkeleton /> : <BillingAccountSkeleton />
  if (accountsQuery.isError) {
    return (
      <BillingUnavailable
        error={accountsQuery.error}
        scope="accounts"
        onRetry={() => void accountsQuery.refetch()}
        isRetrying={accountsQuery.isFetching}
      />
    )
  }

  const managed = accounts.filter((account) => account.canManage)
  const workspaceAccount = current && canReadBillingOf(current) ? current.billingAccount : null
  const opened = upgradeInterval === null ? (workspaceAccount ?? (managed.length === 1 ? managed[0] : undefined)) : undefined
  if (opened) {
    return (
      <>
        <BillingAccountSkeleton />
        <Navigate to="/dashboard/billing/$accountId" params={{ accountId: opened.id }} replace />
      </>
    )
  }

  const upgrading = upgradeInterval !== null && priceKey !== null && upgradable.length > 0

  return (
    <>
      <AccountTopBar crumbs={["Billing"]} />
      <PageBody>
        <PageHeading
          label="Billing"
          title="Billing"
          description={upgrading ? "Choose the account to upgrade to Pro." : "Choose the account to upgrade or manage."}
        />
        {checkout.error && !closedPrice ? (
          <Alert variant="destructive">
            <AlertDescription>{getErrorMessage(checkout.error, "Could not open Checkout.")}</AlertDescription>
          </Alert>
        ) : null}
        {upgrading && priceKey ? (
          <section className="flex flex-col gap-3">
            <SectionLabel>Upgrade to Pro</SectionLabel>
            <ul className="surface-card">
              {upgradable.map((account) => (
                <UpgradeRow
                  key={account.id}
                  account={account}
                  isPending={checkout.isPending && checkout.variables?.accountId === account.id}
                  disabled={checkout.isPending}
                  onUpgrade={() => checkout.mutate({ accountId: account.id, priceKey })}
                />
              ))}
            </ul>
          </section>
        ) : null}
        <section className="flex flex-col gap-3">
          <SectionLabel>Accounts</SectionLabel>
          <BillingAccountCards accounts={accounts} />
        </section>
      </PageBody>
      <OfferClosedDialog
        priceKey={closedPrice?.priceKey ?? null}
        isPending={checkout.isPending}
        onCancel={() => setClosedPrice(null)}
        onAccept={(newKey) => {
          const accountId = closedPrice?.accountId
          setClosedPrice(null)
          if (accountId) checkout.mutate({ accountId, priceKey: newKey })
        }}
      />
    </>
  )
}

function UpgradeRow({
  account,
  isPending,
  disabled,
  onUpgrade,
}: {
  account: BillingAccountSummary
  isPending: boolean
  disabled: boolean
  onUpgrade: () => void
}) {
  return (
    <li className="flex items-center justify-between gap-4 border-t border-divider px-5 py-4 first:border-t-0">
      <span className="truncate text-[14.5px] text-foreground">{billingAccountName(account)}</span>
      <Button
        size="sm"
        disabled={disabled}
        onClick={() => {
          captureBrowserEvent("upgrade_clicked", { location: "billing_accounts" })
          onUpgrade()
        }}
      >
        {isPending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
        {isPending ? "Opening Checkout…" : "Upgrade to Pro"}
      </Button>
    </li>
  )
}
