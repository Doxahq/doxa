import type { BillingInterval } from "@doxahq/billing/catalog"

import { SegmentedControl } from "~/components/dashboard/billing/billing-segmented-control"
import { intervalLabel } from "~/lib/dashboard/billing-model"

/**
 * The Monthly / Yearly choice of a Pro price: the billing page's Upgrade card
 * and the Pro trial dialog. Yearly shows the saving when the offer
 * has one.
 */
export function BillingIntervalControl({
  value,
  onChange,
  yearlySavingsPercent,
}: {
  value: BillingInterval
  onChange: (interval: BillingInterval) => void
  yearlySavingsPercent: number
}) {
  return (
    <SegmentedControl
      label="Billing period"
      value={value}
      onChange={onChange}
      options={(["month", "year"] as const).map((option) => ({
        value: option,
        label: (
          <>
            {intervalLabel(option)}
            {option === "year" && yearlySavingsPercent > 0 ? (
              <span className="ml-1.5 font-mono text-[10px] tracking-[0.12em] text-primary-text">−{yearlySavingsPercent}%</span>
            ) : null}
          </>
        ),
      }))}
    />
  )
}
