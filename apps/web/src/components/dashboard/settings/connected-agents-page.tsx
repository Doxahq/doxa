import { useQuery } from "@tanstack/react-query"

import { AccountPageFrame } from "~/components/dashboard/settings/account-page-frame"
import { ConnectedAgentsSection } from "~/components/dashboard/settings/connected-agents-section"
import { ConnectedAgentsSkeleton } from "~/components/dashboard/skeletons/account-skeletons"
import { ACCOUNT_PAGES } from "~/lib/dashboard/account-pages"
import { useIsFirstLoad } from "~/lib/dashboard/use-first-load"
import { agentGrantsQueryOptions } from "~/lib/queries/agent-access"
import { billingAccountsQueryOptions } from "~/lib/queries/billing"

/** `/dashboard/settings/agents`: the agents that can use the account through MCP. */
export function ConnectedAgentsPage() {
  // The billing accounts fill the Account sidebar's BILLING group, so it shows with the page.
  const isFirstLoad = useIsFirstLoad([
    useQuery(agentGrantsQueryOptions()),
    useQuery(billingAccountsQueryOptions()),
  ])
  if (isFirstLoad) return <ConnectedAgentsSkeleton />

  return (
    <AccountPageFrame page={ACCOUNT_PAGES.connectedAgents}>
      <ConnectedAgentsSection />
    </AccountPageFrame>
  )
}
