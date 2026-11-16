import { useQuery } from "@tanstack/react-query"

import { BillingPastDueBanner } from "~/components/dashboard/billing/billing-past-due-banner"
import { isPastDue } from "~/lib/dashboard/billing-model"
import { useRenderedPathname } from "~/lib/dashboard/use-rendered-pathname"
import { useBillingAccountActions } from "~/lib/dashboard/use-billing-account"
import { billingAccountQueryOptions } from "~/lib/queries/billing"
import { projectDetailQueryOptions } from "~/lib/queries/dashboard"

/**
 * The past-due banner over every page of a project whose billing account is
 * past due (spec 15.2). It reads the project's `billing` field, so it draws
 * nothing while billing is off, and nothing for a viewer who cannot read the
 * account's billing.
 */
export function ProjectBillingBanner({ projectId }: { projectId: string | null }) {
  const detailQuery = useQuery({ ...projectDetailQueryOptions(projectId ?? ""), enabled: projectId !== null })
  const accountId = detailQuery.data?.billing?.accountId ?? null
  // The billing pages show the account's own state: Plan and invoices has its own banner.
  const onBillingPage = /^\/dashboard\/billing(?:\/|$)/.test(useRenderedPathname())
  const accountQuery = useQuery({
    ...billingAccountQueryOptions(accountId ?? ""),
    enabled: accountId !== null && !onBillingPage,
    staleTime: 60_000,
  })
  const detail = accountQuery.data
  if (onBillingPage || !accountId || !detail || !isPastDue(detail)) return null
  return <PastDueStrip accountId={accountId} canManage={detail.canManage} />
}

function PastDueStrip({ accountId, canManage }: { accountId: string; canManage: boolean }) {
  const actions = useBillingAccountActions(accountId)
  return (
    <div className="px-4 pt-4 sm:px-6">
      <BillingPastDueBanner
        canManage={canManage}
        isPending={actions.portal.isPending}
        error={actions.errorOf(actions.portal, "Could not open billing.")}
        onUpdateCard={() => actions.portal.mutate("payment_method_update")}
      />
    </div>
  )
}
