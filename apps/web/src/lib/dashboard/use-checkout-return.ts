import { useCallback, useEffect, useRef, useState } from "react"
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import type { BillingAccountDetail } from "@doxahq/contracts/billing"

import { syncBillingCheckout } from "~/lib/billing-api"
import { CHECKOUT_RETURN_PARAM, checkoutSessionOf } from "~/lib/dashboard/checkout-return"
import { billingQueryKeys } from "~/lib/queries/billing"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"

/**
 * Outside the `billing` and `dashboard` keys: an invalidation of those keys
 * must not sync the session again.
 */
const checkoutSyncKey = (sessionId: string) => ["checkout-sync", sessionId] as const

export interface CheckoutReturnState {
  /** The sync of the returned session runs. */
  isPending: boolean
  /** The sync answered. The account reads show the plan as the provider has it. */
  isSuccess: boolean
}

/**
 * The Checkout return (spec 14.2): the success URL carries `?checkout=<id>`.
 * The page syncs that session once, then `onHandled` drops the parameter
 * from the URL. The sync answers the account as the provider has it, so
 * the new plan shows before the webhook arrives: the account, the account
 * list (the AI access of the new project page) and every project read of the
 * account (their `billing.plan`) are refreshed.
 *
 * A query, not a mutation: a mutation observer that unsubscribes and
 * subscribes again (a route or Suspense boundary that hides the page for a
 * moment) does not see its running mutation end, so the page stayed on
 * "pending" for good. A query observer attaches to its query again.
 */
export function useCheckoutReturn(sessionId: string | null, onHandled: () => void): CheckoutReturnState {
  const queryClient = useQueryClient()
  // The last returned session. It stays after `onHandled` drops the parameter, so the result stays on the page.
  const [activeId, setActiveId] = useState(sessionId)
  if (sessionId !== null && sessionId !== activeId) setActiveId(sessionId)

  const sync = useQuery({
    queryKey: checkoutSyncKey(activeId ?? ""),
    queryFn: async () => applyCheckoutSync(queryClient, await syncBillingCheckout(activeId ?? "")),
    enabled: activeId !== null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })

  const onHandledRef = useRef(onHandled)
  onHandledRef.current = onHandled
  const handledRef = useRef<string | null>(null)
  const settled = sync.isSuccess || sync.isError
  useEffect(() => {
    if (sessionId === null || !settled || handledRef.current === sessionId) return
    handledRef.current = sessionId
    onHandledRef.current()
  }, [sessionId, settled])

  return { isPending: activeId !== null && sync.isPending, isSuccess: sync.isSuccess }
}

/**
 * Puts the synced account in the cache at once, then refreshes the other
 * reads in the background: the sync is done when the account shows.
 *
 * A read that started before the sync ended can answer the plan from before
 * it, and an invalidation joins that read instead of starting a new one. So
 * the reads are cancelled first. A cancel puts back the data from before the
 * read, so the synced account goes in after it.
 */
async function applyCheckoutSync(queryClient: QueryClient, detail: BillingAccountDetail): Promise<BillingAccountDetail> {
  const queryKeys = [
    billingQueryKeys.account(detail.id),
    billingQueryKeys.accounts(),
    [...billingQueryKeys.all, "estimate"],
    // Every project of the account changes plan.
    dashboardQueryKeys.all,
  ]
  await Promise.all(queryKeys.map((queryKey) => queryClient.cancelQueries({ queryKey })))
  queryClient.setQueryData(billingQueryKeys.detail(detail.id), detail)
  for (const queryKey of queryKeys) void queryClient.invalidateQueries({ queryKey })
  return detail
}

/**
 * `useCheckoutReturn` for a page whose route does not declare `checkout`
 * (the project pages that offer the Pro trial): it reads the parameter from
 * the location and removes it with a replace, keeping the other parameters.
 */
export function useLocationCheckoutReturn() {
  const navigate = useNavigate()
  const search = useRouterState({ select: (state) => state.location.search as Record<string, unknown> })
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const sessionId = checkoutSessionOf(search)
  const clear = useCallback(() => {
    const params = new URLSearchParams(globalThis.location?.search ?? "")
    params.delete(CHECKOUT_RETURN_PARAM)
    const query = params.toString()
    void navigate({ href: `${pathname}${query ? `?${query}` : ""}`, replace: true })
  }, [navigate, pathname])
  return useCheckoutReturn(sessionId, clear)
}
