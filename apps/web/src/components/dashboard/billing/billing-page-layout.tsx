import type { ReactNode } from "react"
import type { BillingAccountDetail, BillingAccountSummary } from "@doxahq/contracts/billing"

import { PageBody, PageHeading } from "~/components/dashboard/dashboard-header"
import { BillingAccountSwitcher } from "~/components/dashboard/billing/billing-account-switcher"
import { LoadingLabel } from "~/components/dashboard/route-pending"
import { BillingAccountSkeleton, BillingCreditsSkeleton } from "~/components/dashboard/skeletons/billing-skeletons"
import { AccountTopBar } from "~/components/dashboard/shell/top-bar"
import {
  BILLING_PAGE_TITLES,
  billingPageCrumbs,
  billingPageDescription,
  type BillingPage,
} from "~/lib/dashboard/billing-pages"

/**
 * The frame of a billing page of one account: the "Account / Billing / …"
 * top bar, the heading, and the account switcher when the viewer has more
 * than one account. `banner` sits above the heading (the past-due banner).
 */
export function BillingPageLayout({
  page,
  detail,
  accounts,
  banner,
  children,
}: {
  page: BillingPage
  detail: Pick<BillingAccountDetail, "id" | "ownerKind" | "name">
  accounts: readonly BillingAccountSummary[]
  banner?: ReactNode
  children: ReactNode
}) {
  return (
    <>
      <AccountTopBar crumbs={billingPageCrumbs(page)} />
      <PageBody>
        {banner}
        <div className="flex flex-col gap-4">
          <PageHeading label="Billing" title={BILLING_PAGE_TITLES[page]} description={billingPageDescription(page, detail)} />
          <BillingAccountSwitcher accounts={accounts} currentId={detail.id} page={page} />
        </div>
        {children}
      </PageBody>
    </>
  )
}

/**
 * A billing page while it loads another account from the switcher: the same
 * frame, already on the new account, with a spinner in place of the sections.
 * Without it, the empty states of the new account flash before its data.
 */
export function BillingPageSwitching({
  page,
  accountId,
  accounts,
}: {
  page: BillingPage
  accountId: string
  accounts: readonly BillingAccountSummary[]
}) {
  const account = accounts.find((candidate) => candidate.id === accountId)
  // Only the switcher starts a switch, so the account is in the list. A stale list falls back to the page skeleton.
  if (!account) return page === "plan" ? <BillingAccountSkeleton /> : <BillingCreditsSkeleton />
  return (
    <BillingPageLayout page={page} detail={account} accounts={accounts}>
      <LoadingLabel label="Loading..." className="min-h-64" />
    </BillingPageLayout>
  )
}
