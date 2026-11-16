import { Link } from "@tanstack/react-router"
import { Check, ChevronsUpDown } from "lucide-react"
import type { BillingAccountSummary } from "@doxahq/contracts/billing"

import { billingAccountName } from "~/components/dashboard/billing/billing-account-cards"
import { Button } from "~/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu"
import type { BillingPage } from "~/lib/dashboard/billing-pages"

/**
 * The account a billing page shows, when the viewer has more than one
 * (a personal account and team accounts). Each item opens the same page for
 * that account. With one account it draws nothing.
 */
export function BillingAccountSwitcher({
  accounts,
  currentId,
  page,
}: {
  accounts: readonly BillingAccountSummary[]
  currentId: string
  page: BillingPage
}) {
  if (accounts.length < 2) return null
  const current = accounts.find((account) => account.id === currentId)
  return (
    <div className="flex items-center gap-2.5">
      <span className="font-mono text-[11px] tracking-[0.16em] text-label uppercase">Account</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="max-w-full min-w-0">
            <span className="truncate">{current ? billingAccountName(current) : "Choose an account"}</span>
            <ChevronsUpDown aria-hidden="true" className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64 font-sans">
          {accounts.map((account) => (
            <DropdownMenuItem key={account.id} asChild>
              <Link
                to={page === "plan" ? "/dashboard/billing/$accountId" : "/dashboard/billing/$accountId/credits"}
                params={{ accountId: account.id }}
              >
                <span className="min-w-0 flex-1 truncate">{billingAccountName(account)}</span>
                {account.id === currentId ? <Check aria-label="Current account" className="ml-auto text-primary-text" /> : null}
              </Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
