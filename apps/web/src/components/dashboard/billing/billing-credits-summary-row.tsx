import { Link } from "@tanstack/react-router"
import { ChevronRight, Coins } from "lucide-react"
import type { BillingAccountDetail } from "@doxahq/contracts/billing"

import { creditsSummaryLine } from "~/lib/dashboard/billing-plan-view"

/** The AI credits row of Plan and invoices: what is left, and pay-as-you-go. The whole row is one link. */
export function BillingCreditsSummaryRow({ detail }: { detail: BillingAccountDetail }) {
  return (
    <Link
      to="/dashboard/billing/$accountId/credits"
      params={{ accountId: detail.id }}
      className="surface-card flex items-center gap-3.5 px-5 py-4 transition-colors duration-75 hover:bg-surface-hover"
    >
      <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-md bg-primary-wash text-primary-text">
        <Coins className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[14.5px] font-medium text-foreground">AI credits</span>
        <span className="text-[13px] text-muted-foreground">{creditsSummaryLine(detail)}</span>
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 text-[13px] text-muted-foreground">
        Open
        <ChevronRight aria-hidden="true" className="size-3.5" />
      </span>
    </Link>
  )
}
