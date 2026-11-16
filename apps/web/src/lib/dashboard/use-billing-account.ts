import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import type { BillingAccountDetail, BillingPortalInput } from "@doxahq/contracts/billing"

import {
  createBillingCheckout,
  createBillingPortal,
  startProNow,
  switchBillingPlanInterval,
  updateBillingCap,
  updateBillingPayg,
} from "~/lib/billing-api"
import { getErrorMessage } from "~/lib/errors"
import { billingAccountQueryOptions, billingAccountsQueryOptions, billingQueryKeys } from "~/lib/queries/billing"

/** Opens a provider page (Checkout, the Portal, an invoice) in this tab. */
export function openBillingUrl(url: string): void {
  window.location.assign(url)
}

/** Refreshes one account, the account list, and the estimates that read its credits. */
function refreshBillingAccount(queryClient: QueryClient, accountId: string): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: billingQueryKeys.account(accountId) }),
    queryClient.invalidateQueries({ queryKey: billingQueryKeys.accounts() }),
    queryClient.invalidateQueries({ queryKey: [...billingQueryKeys.all, "estimate"] }),
  ])
}

/** The two reads every account page shares: the account, and the accounts the viewer can switch to. */
export function useBillingAccountQueries(accountId: string) {
  const detailQuery = useQuery(billingAccountQueryOptions(accountId))
  const accountsQuery = useQuery(billingAccountsQueryOptions())
  return { detailQuery, accountsQuery }
}

/** Opens the Customer Portal of the account, optionally on one flow (card update, cancel). */
export function useBillingPortal(accountId: string) {
  return useMutation({
    mutationFn: (flow?: BillingPortalInput["flow"]) => createBillingPortal(accountId, flow),
    onSuccess: openBillingUrl,
  })
}

/**
 * Start Pro now (decision D22). The API answers the synced account, so the
 * page shows Pro at once: the answer goes into the account cache, and the
 * reads that depend on the plan refresh.
 */
export function useStartProNow(accountId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => startProNow(accountId),
    onSuccess: async (detail: BillingAccountDetail) => {
      queryClient.setQueryData(billingQueryKeys.detail(accountId), detail)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: billingQueryKeys.invoices(accountId) }),
        queryClient.invalidateQueries({ queryKey: billingQueryKeys.entries(accountId) }),
        queryClient.invalidateQueries({ queryKey: billingQueryKeys.accounts() }),
        queryClient.invalidateQueries({ queryKey: [...billingQueryKeys.all, "estimate"] }),
      ])
    },
    // A 409 means the provider already ended the trial: show the account as it is now.
    onError: () => queryClient.invalidateQueries({ queryKey: billingQueryKeys.detail(accountId) }),
  })
}

/**
 * The billing actions of one account. Each change refreshes the account, and
 * the project reads that carry its plan.
 */
export function useBillingAccountActions(accountId: string) {
  const queryClient = useQueryClient()
  const refresh = () => refreshBillingAccount(queryClient, accountId)

  const checkout = useMutation({
    mutationFn: (priceKey: string) => createBillingCheckout(accountId, priceKey),
    onSuccess: openBillingUrl,
  })
  const portal = useBillingPortal(accountId)
  const payg = useMutation({
    mutationFn: (input: { enabled?: boolean; monthlyLimitCents?: number }) => updateBillingPayg(accountId, input),
    onSuccess: refresh,
  })
  const cap = useMutation({
    mutationFn: (input: { action: string; capCredits: number }) => updateBillingCap(accountId, input.action, input.capCredits),
    onSuccess: refresh,
  })
  const planInterval = useMutation({
    mutationFn: (input: { interval: "month" | "year"; idempotencyKey: string }) =>
      switchBillingPlanInterval(accountId, input.interval, input.idempotencyKey),
    onSuccess: refresh,
  })

  return {
    checkout,
    portal,
    payg,
    cap,
    planInterval,
    errorOf: (mutation: { error: unknown }, fallback: string): string | null =>
      mutation.error ? getErrorMessage(mutation.error, fallback) : null,
  }
}
