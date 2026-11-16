import { Link } from "@tanstack/react-router"
import { CreditCard, Loader2, RotateCw } from "lucide-react"

import { EmptyState, PageBody } from "~/components/dashboard/dashboard-header"
import { AccountTopBar } from "~/components/dashboard/shell/top-bar"
import { Button } from "~/components/ui/button"
import { isBillingAccountNotFound, isBillingNotConfigured } from "~/lib/queries/billing"

/**
 * What a failed billing read shows:
 * - "Billing is not available": the API answered that billing is off, or, on
 *   the account list, that the billing routes do not exist (an older API).
 * - "Billing account not found": the API answered 403 or 404 for one account.
 * - Anything else (a network failure, a 5xx, or an answer that did not come
 *   from the API, such as a tunnel's HTML 404): "Could not load billing."
 *   with Try again.
 */
export type BillingUnavailableKind = "not_configured" | "not_found" | "failed"

export function billingUnavailableKind(error: unknown, scope: "accounts" | "account"): BillingUnavailableKind {
  if (isBillingNotConfigured(error)) return "not_configured"
  if (!isBillingAccountNotFound(error)) return "failed"
  // The account list has no account to miss: an API 404 there means an older
  // API without the billing routes.
  return scope === "accounts" ? "not_configured" : "not_found"
}

export function BillingUnavailable({
  error,
  scope,
  onRetry,
  isRetrying = false,
}: {
  error: unknown
  /** The account list (`/dashboard/billing`) or one account (`/dashboard/billing/<id>`). */
  scope: "accounts" | "account"
  onRetry: () => void
  isRetrying?: boolean
}) {
  const kind = billingUnavailableKind(error, scope)
  return (
    <>
      <AccountTopBar crumbs={["Billing"]} />
      <PageBody>
        {kind === "failed" ? (
          <EmptyState
            icon={<CreditCard />}
            title="Could not load billing"
            description="Doxa could not reach the billing service. Check your connection, then try again."
            action={
              <Button variant="outline" size="sm" onClick={onRetry} disabled={isRetrying}>
                {isRetrying ? <Loader2 aria-hidden="true" className="animate-spin" /> : <RotateCw aria-hidden="true" />}
                Try again
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={<CreditCard />}
            title={kind === "not_configured" ? "Billing is not available" : "Billing account not found"}
            description={
              kind === "not_configured"
                ? "Billing is not set up on this server. Every feature works without a plan."
                : "This account does not exist, or you cannot see its billing."
            }
            action={
              <Button variant="outline" size="sm" asChild>
                <Link to="/dashboard/settings">Account settings</Link>
              </Button>
            }
          />
        )}
      </PageBody>
    </>
  )
}
