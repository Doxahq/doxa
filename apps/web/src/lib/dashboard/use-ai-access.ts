import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { BillingInterval } from "@doxahq/billing/catalog"

import { offerClosedPrice } from "~/lib/dashboard/offer-closed"
import { createBillingCheckout } from "~/lib/billing-api"
import { AI_ACCESS_LOADING, newProjectAiAccess, projectAiAccess, type AiGenerationAccess } from "~/lib/dashboard/ai-access"
import { currentDashboardReturnPath } from "~/lib/dashboard/checkout-return"
import { founderOffer } from "~/lib/dashboard/billing-model"
import { openBillingUrl } from "~/lib/dashboard/use-billing-account"
import { useCheckoutReturn } from "~/lib/dashboard/use-checkout-return"
import { useProjectCapabilities } from "~/lib/dashboard/use-project-capabilities"
import type { Workspace } from "~/lib/dashboard/workspace-model"
import { billingAccountsQueryOptions, billingOffersQueryOptions } from "~/lib/queries/billing"
import { projectDetailQueryOptions } from "~/lib/queries/dashboard"

/** How often the new project page reads the plan again while a Checkout return waits for it. */
export const CHECKOUT_PLAN_POLL_MS = 2_000
/** How long the new project page waits for the plan of a Checkout return before it shows the Free state again. */
export const CHECKOUT_PLAN_WAIT_MS = 60_000

/**
 * The Doxa Agent access of the project that the new project page creates in
 * `workspace` (its billing account). Null while the workspace is not known:
 * the access stays `loading`, so the page keeps its reserved state.
 *
 * With `checkout` (the Pro trial's Checkout returned here with
 * `?checkout=<id>`), the session is synced once and the parameter dropped
 * (`onHandled`). Until the account has the Doxa Agent, the access stays
 * `loading`, so the page keeps its reserved, page-shaped state and opens no
 * dialog. When the webhook lags behind the sync, the account list is read
 * again every 2 seconds, for up to a minute; then the Free state shows again.
 */
export function useNewProjectAiAccess(
  workspace: Pick<Workspace, "teamId"> | null,
  checkout?: { sessionId: string | null; onHandled: () => void },
): AiGenerationAccess {
  const sessionId = checkout?.sessionId ?? null
  const [awaitingPlan, setAwaitingPlan] = useState(sessionId !== null)
  const sync = useCheckoutReturn(sessionId, checkout?.onHandled ?? noop)
  const query = useQuery({
    ...billingAccountsQueryOptions(),
    refetchInterval: awaitingPlan && !sync.isPending ? CHECKOUT_PLAN_POLL_MS : false,
  })
  // Only the first load counts as loading. A failed read with no data goes back
  // to `pending` when it runs again (the workspace menu enables the same query
  // once the page settles), and the card must not turn back into its skeleton.
  const isFirstLoad = query.isPending && query.errorUpdatedAt === 0
  const access = workspace
    ? newProjectAiAccess({ isPending: isFirstLoad, data: query.data }, workspace.teamId)
    : AI_ACCESS_LOADING
  const isOpen = access.kind === "open"

  useEffect(() => {
    if (awaitingPlan && isOpen) setAwaitingPlan(false)
  }, [awaitingPlan, isOpen])
  useEffect(() => {
    if (!awaitingPlan) return
    const timer = setTimeout(() => setAwaitingPlan(false), CHECKOUT_PLAN_WAIT_MS)
    return () => clearTimeout(timer)
  }, [awaitingPlan])

  return awaitingPlan && !isOpen ? AI_ACCESS_LOADING : access
}

function noop(): void {}

/** The Doxa Agent access of an existing project, from its `billing` field. */
export function useProjectAiAccess(projectId: string): AiGenerationAccess {
  const detail = useQuery(projectDetailQueryOptions(projectId))
  const canManageBilling = useProjectCapabilities(projectId).can("billing.manage")
  return projectAiAccess({
    isPending: detail.isPending,
    billing: detail.data?.billing,
    canManageBilling,
  })
}

/**
 * Starts the Pro trial through Checkout, as the billing page's Upgrade does:
 * the price of the current offer (the founder price while it is open) for
 * `interval`, yearly by default. When the founder offer filled up meanwhile,
 * the API answers 409 `offer_closed` with the new price, and `closedPriceKey`
 * asks the person to accept it before Checkout opens.
 *
 * `returnPath` is where Checkout comes back to; by default the dashboard page
 * the button is on.
 */
export function useProTrialCheckout(accountId: string, returnPath?: string, interval: BillingInterval = "year") {
  const queryClient = useQueryClient()
  const [closedPriceKey, setClosedPriceKey] = useState<string | null>(null)

  const checkout = useMutation({
    mutationFn: async (priceKey: string | null) => {
      const key = priceKey ?? founderOffer(await queryClient.fetchQuery(billingOffersQueryOptions()))?.prices[interval].priceKey
      if (!key) throw new Error("No Pro price is on sale right now.")
      return createBillingCheckout(accountId, key, returnPath ?? currentDashboardReturnPath())
    },
    onSuccess: openBillingUrl,
    onError: (error) => {
      const price = offerClosedPrice(error)
      if (price) setClosedPriceKey(price)
    },
  })

  return {
    start: () => checkout.mutate(null),
    isPending: checkout.isPending,
    /** Null while the founder-offer question is open: the dialog explains it. */
    error: checkout.error && offerClosedPrice(checkout.error) === null ? checkout.error : null,
    closedPriceKey,
    cancelClosedOffer: () => setClosedPriceKey(null),
    acceptClosedOffer: (priceKey: string) => {
      setClosedPriceKey(null)
      checkout.mutate(priceKey)
    },
  }
}
