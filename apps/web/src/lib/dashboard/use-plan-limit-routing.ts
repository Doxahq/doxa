import { useEffect, useState } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { useParams } from "@tanstack/react-router"
import type { PlanLimitErrorDetails } from "@doxahq/contracts/billing"

import {
  accountIdFromBillingUrl,
  planLimitProTrialRequest,
  showBillingDenial,
  type BillingDenial,
  type PlanLimitTarget,
} from "~/lib/dashboard/billing-denials"
import { useProTrialDialog } from "~/lib/dashboard/pro-trial-dialog"
import { billingAccountsQueryOptions } from "~/lib/queries/billing"
import { projectDetailQueryOptions } from "~/lib/queries/dashboard"

/**
 * The account and plan of a 403 `plan_limit`. Project routes do not put them
 * in the answer, so they come from the billing link, the project of the page
 * (its `billing` field) or the team of the page, and the account list says
 * whether the viewer manages that account. A failed lookup leaves them null.
 */
async function resolvePlanLimitTarget(
  queryClient: QueryClient,
  details: PlanLimitErrorDetails,
  route: { projectId: string | null; teamId: string | null },
): Promise<PlanLimitTarget> {
  const projectBilling = route.projectId
    ? (queryClient.getQueryData(projectDetailQueryOptions(route.projectId).queryKey)?.billing ?? null)
    : null
  const list = await queryClient.fetchQuery(billingAccountsQueryOptions()).catch(() => null)
  const accounts = list?.accounts ?? []
  const accountId =
    accountIdFromBillingUrl(details.upgradeUrl) ??
    projectBilling?.accountId ??
    (route.teamId ? (accounts.find((account) => account.ownerKind === "team" && account.ownerId === route.teamId)?.id ?? null) : null)
  const account = accountId ? accounts.find((candidate) => candidate.id === accountId) : undefined
  const plan = account?.plan ?? (projectBilling && projectBilling.accountId === accountId ? projectBilling.plan : null)
  return { accountId, plan, canManage: account?.canManage ?? false, name: account?.name ?? null }
}

/**
 * Sends a 403 `plan_limit` that the Pro trial unlocks on a Free account to the
 * Pro trial dialog, and clears it from the denial store. Returns true when the
 * denial is one for the "Plan limit reached" dialog. While the account is
 * looked up, neither dialog shows, so the plan limit dialog never flashes
 * before the Pro trial dialog.
 */
export function usePlanLimitRouting(denial: BillingDenial | null): boolean {
  const queryClient = useQueryClient()
  const dialog = useProTrialDialog()
  const params = useParams({ strict: false }) as Record<string, unknown>
  const projectId = typeof params.projectId === "string" ? params.projectId : null
  const teamId = typeof params.teamId === "string" ? params.teamId : null
  const [limitDetails, setLimitDetails] = useState<PlanLimitErrorDetails | null>(null)
  const details = denial?.kind === "plan_limit" ? denial.details : null

  useEffect(() => {
    if (!details) return
    let cancelled = false
    void resolvePlanLimitTarget(queryClient, details, { projectId, teamId }).then((target) => {
      if (cancelled) return
      const request = planLimitProTrialRequest(details, target)
      if (!request) {
        setLimitDetails(details)
        return
      }
      showBillingDenial(null)
      dialog.open(request)
    })
    return () => {
      cancelled = true
    }
    // The route at the moment of the denial decides; a later route change does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [details])

  return details !== null && limitDetails === details
}
