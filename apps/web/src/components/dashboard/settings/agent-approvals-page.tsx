import { useQuery } from "@tanstack/react-query"

import { AccountPageFrame } from "~/components/dashboard/settings/account-page-frame"
import { UserApprovalSettingsSection } from "~/components/dashboard/settings/user-approval-settings-section"
import { AgentApprovalsSkeleton } from "~/components/dashboard/skeletons/account-skeletons"
import { ACCOUNT_PAGES } from "~/lib/dashboard/account-pages"
import { useIsFirstLoad } from "~/lib/dashboard/use-first-load"
import { userApprovalSettingsQueryOptions } from "~/lib/queries/approval-settings"
import { billingAccountsQueryOptions } from "~/lib/queries/billing"

/** `/dashboard/settings/approvals`: what the person's agents can do without asking, in every project. */
export function AgentApprovalsPage() {
  // The billing accounts fill the Account sidebar's BILLING group, so it shows with the page.
  const isFirstLoad = useIsFirstLoad([
    useQuery(userApprovalSettingsQueryOptions()),
    useQuery(billingAccountsQueryOptions()),
  ])
  if (isFirstLoad) return <AgentApprovalsSkeleton />

  return (
    <AccountPageFrame page={ACCOUNT_PAGES.agentApprovals}>
      <UserApprovalSettingsSection />
    </AccountPageFrame>
  )
}
