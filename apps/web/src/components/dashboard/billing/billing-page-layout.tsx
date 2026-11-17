import type { ReactNode } from "react"
import type { BillingAccountDetail, BillingAccountSummary } from "@doxahq/contracts/billing"

import { PageBody, PageHeading } from "~/components/dashboard/dashboard-header"
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
 * The frame of a billing page of one account: the top bar ("Coder One /
 * Billing / …", or "Account / Billing / …" with only the personal
 * workspace), and the heading. The account is the current workspace's: the
 * logo menu switches it. `banner` sits above the heading (the past-due banner).
 */
export function BillingPageLayout({
  page,
  detail,
  banner,
  children,
}: {
  page: BillingPage
  detail: Pick<BillingAccountDetail, "ownerKind" | "name">
  banner?: ReactNode
  children: ReactNode
}) {
  return (
    <>
      <AccountTopBar crumbs={billingPageCrumbs(page)} />
      <PageBody>
        {banner}
        <PageHeading label="Billing" title={BILLING_PAGE_TITLES[page]} description={billingPageDescription(page, detail)} />
        {children}
      </PageBody>
    </>
  )
}

/**
 * A billing page while it loads another account after a workspace switch:
 * the same frame, already on the new account, with a spinner in place of the
 * sections. Without it, the empty states of the new account flash before its data.
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
  // A switch goes to an account of the list. A stale list falls back to the page skeleton.
  if (!account) return page === "plan" ? <BillingAccountSkeleton /> : <BillingCreditsSkeleton />
  return (
    <BillingPageLayout page={page} detail={account}>
      <LoadingLabel label="Loading..." className="min-h-64" />
    </BillingPageLayout>
  )
}
