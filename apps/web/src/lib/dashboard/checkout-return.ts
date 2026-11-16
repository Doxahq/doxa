import { checkoutReturnPathProblem } from "@doxahq/contracts/billing"

/** The search parameter of the Checkout return (billing spec 14.2): the session to sync. */
export const CHECKOUT_RETURN_PARAM = "checkout"

/**
 * The dashboard page to come back to after Checkout: the current path and
 * query, without a stale `checkout` parameter. Undefined outside the
 * dashboard (or on the server), so the API's default, the billing page, applies.
 */
export function currentDashboardReturnPath(location: Pick<Location, "pathname" | "search"> | undefined = globalThis.location):
  | string
  | undefined {
  if (!location) return undefined
  const params = new URLSearchParams(location.search)
  params.delete(CHECKOUT_RETURN_PARAM)
  const query = params.toString()
  const path = `${location.pathname}${query ? `?${query}` : ""}`
  return checkoutReturnPathProblem(path) === null ? path : undefined
}

/** The Checkout session of a return URL's search, or null. */
export function checkoutSessionOf(search: Readonly<Record<string, unknown>>): string | null {
  const value = search[CHECKOUT_RETURN_PARAM]
  return typeof value === "string" && value.length > 0 ? value : null
}
