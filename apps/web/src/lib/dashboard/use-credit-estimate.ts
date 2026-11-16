import { useQuery } from "@tanstack/react-query"
import type { BillingAccountList, ProjectBilling } from "@doxahq/contracts/billing"

import {
  creditEstimateView,
  defaultRunEstimate,
  isNextRunCold,
  pullRequestRunEstimate,
  type CreditEstimateView,
  type MeteredRunAction,
} from "~/lib/dashboard/run-estimate"
import { billingAccountQueryOptions, billingAccountsQueryOptions, creditEstimateQueryOptions } from "~/lib/queries/billing"
import { projectDetailQueryOptions, projectGenerationCacheQueryOptions } from "~/lib/queries/dashboard"

/**
 * - `off`: billing enforcement is not `on` (the project's `billing` is null,
 *   or its `enforcement` is `off` or `shadow`), so nothing shows.
 * - `loading`: the estimate is on its way; the caller keeps its space.
 * - `ready`: the view, and `cold` when asked for (null when the cache is unknown).
 */
export type CreditEstimateState =
  | { kind: "off" }
  | { kind: "loading" }
  | { kind: "ready"; view: CreditEstimateView; cold: boolean | null }

const OFF: CreditEstimateState = { kind: "off" }
const LOADING: CreditEstimateState = { kind: "loading" }

/**
 * The estimate of the next run of `action` (spec 10.5, 15.2): "About
 * 220–300 credits. Stops at 3,000.", the pay-as-you-go part when the run goes
 * above the grants, and the trial cap note.
 *
 * `projectId` null is the project that the new project page creates: it has
 * no history, so the estimate is the default one with the personal account's
 * cap, and the run is always cold. `withRunTemperature` also reads the
 * project's generation cache for `cold`.
 */
export function useCreditEstimate(
  projectId: string | null,
  action: MeteredRunAction,
  options: { enabled?: boolean; withRunTemperature?: boolean } = {},
): CreditEstimateState {
  const enabled = options.enabled ?? true
  const isNewProject = projectId === null
  const projectQuery = useQuery({ ...projectDetailQueryOptions(projectId ?? ""), enabled: enabled && !isNewProject })
  const accountsQuery = useQuery({ ...billingAccountsQueryOptions(), enabled: enabled && isNewProject })

  const accountId = isNewProject ? newProjectAccountId(accountsQuery.data) : projectAccountId(projectQuery.data?.billing)
  const active = enabled && accountId !== null
  const estimateQuery = useQuery({ ...creditEstimateQueryOptions(projectId ?? "", action), enabled: active && !isNewProject })
  // A viewer without `billing.read` gets 403: the line then has no pay-as-you-go part and no trial note.
  const accountQuery = useQuery({ ...billingAccountQueryOptions(accountId ?? ""), enabled: active })
  const readsCache = active && !isNewProject && options.withRunTemperature === true
  const cacheQuery = useQuery({ ...projectGenerationCacheQueryOptions(projectId ?? ""), enabled: readsCache })

  const ownerPending = isNewProject ? accountsQuery.isPending : projectQuery.isPending
  if (!enabled) return OFF
  if (!active) return ownerPending ? LOADING : OFF
  if (accountQuery.isPending || (!isNewProject && estimateQuery.isPending) || (readsCache && cacheQuery.isPending)) {
    return LOADING
  }
  const detail = accountQuery.data ?? null
  const estimate = isNewProject ? defaultRunEstimate(action, detail) : estimateQuery.data
  if (!estimate) return OFF
  return {
    kind: "ready",
    view: creditEstimateView(estimate, detail),
    cold: isNewProject ? true : isNextRunCold(cacheQuery.data, action),
  }
}

/**
 * The action and lead-in of the Doxabot page's estimate: the next pull
 * request run as the bill charges it (decision D21). Clear cache invalidates
 * the generation cache query, so the line follows it.
 */
export function usePullRequestRunEstimate(projectId: string): ReturnType<typeof pullRequestRunEstimate> {
  const cacheQuery = useQuery(projectGenerationCacheQueryOptions(projectId))
  return pullRequestRunEstimate(cacheQuery.data)
}

function projectAccountId(billing: ProjectBilling | null | undefined): string | null {
  return billing?.enforcement === "on" ? billing.accountId : null
}

/** The personal account, which bills a project made on the new project page (spec 8.1). */
function newProjectAccountId(list: BillingAccountList | undefined): string | null {
  if (list?.enforcement !== "on") return null
  return list.accounts.find((account) => account.ownerKind === "user")?.id ?? null
}
