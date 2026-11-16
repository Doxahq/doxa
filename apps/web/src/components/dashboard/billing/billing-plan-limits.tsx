import type { BillingAccountDetail } from "@doxahq/contracts/billing"

import { SectionLabel } from "~/components/dashboard/dashboard-header"
import { planLimitRows } from "~/lib/dashboard/billing-plan-view"

/**
 * PLAN LIMITS of a Free account. The API sends the limits of the plan, not
 * the use of each one, so the list has no usage bars.
 */
export function BillingPlanLimits({ detail }: { detail: BillingAccountDetail }) {
  const rows = planLimitRows(detail)
  if (rows.length === 0) return null
  return (
    <section className="flex flex-col gap-3" aria-labelledby="billing-plan-limits">
      <SectionLabel>
        <span id="billing-plan-limits">Plan limits</span>
      </SectionLabel>
      <dl className="surface-card">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-4 border-t border-divider px-5 py-3.5 first:border-t-0">
            <dt className="text-[14.5px] text-foreground">{row.label}</dt>
            <dd className="font-mono text-[13px] text-foreground">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
