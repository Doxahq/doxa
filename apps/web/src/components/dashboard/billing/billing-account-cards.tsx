import { Link } from "@tanstack/react-router"
import { ChevronRight, User, Users } from "lucide-react"
import type { BillingAccountSummary } from "@doxahq/contracts/billing"

import { BillingStatusBadge } from "~/components/dashboard/billing/billing-status-badge"
import { planName } from "~/lib/dashboard/billing-model"

export function billingAccountName(account: Pick<BillingAccountSummary, "ownerKind" | "name">): string {
  return account.ownerKind === "user" ? "Personal account" : (account.name ?? "Team account")
}

/**
 * One card per billing account (spec 15.2). The whole card is one link, so it
 * has a hover fill.
 */
export function BillingAccountCards({ accounts }: { accounts: readonly BillingAccountSummary[] }) {
  return (
    <ul className="surface-card">
      {accounts.map((account) => {
        const Icon = account.ownerKind === "user" ? User : Users
        return (
          <li key={account.id} className="border-t border-divider first:border-t-0">
            <Link
              to="/dashboard/billing/$accountId"
              params={{ accountId: account.id }}
              className="flex items-center justify-between gap-4 px-5 py-4 transition-colors duration-75 hover:bg-surface-hover focus-visible:-outline-offset-2"
            >
              <span className="flex min-w-0 items-center gap-3">
                <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-[14.5px] font-medium text-foreground">{billingAccountName(account)}</span>
                  <span className="text-xs text-muted-foreground">
                    {account.canManage ? "You manage billing" : "You can view billing"}
                  </span>
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <BillingStatusBadge label={planName(account.plan)} tone={account.plan === "free" ? "muted" : "success"} />
                <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
