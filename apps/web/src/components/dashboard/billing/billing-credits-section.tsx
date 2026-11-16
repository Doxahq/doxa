import type { BillingAccountDetail } from "@doxahq/contracts/billing"

import { FIELD_LABEL_CLASS, SectionLabel } from "~/components/dashboard/dashboard-header"
import { MeterBar } from "~/components/dashboard/billing/billing-status-badge"
import { creditMeterView, formatBillingDate, formatCredits, isCanceledTrial } from "~/lib/dashboard/billing-model"
import { creditsAndUsd } from "~/lib/dashboard/billing-plan-view"
import { cn } from "~/lib/utils"

/**
 * THIS MONTH: the credits left of the allowance (or of the trial credits), a
 * meter, what came from the monthly credits and from pay-as-you-go, and the
 * reset date.
 */
export function BillingCreditsSection({ detail }: { detail: BillingAccountDetail }) {
  const meter = creditMeterView(detail)
  const trialEnd = detail.subscription?.status === "trialing" ? detail.subscription.trialEnd : null
  const trialing = detail.subscription?.status === "trialing"
  const canceled = isCanceledTrial(detail)
  const low = meter.total !== null && meter.percentUsed >= 80
  const facts = [
    { label: trialing ? "From trial credits" : "From monthly credits", value: `${formatCredits(meter.used)} credits` },
    {
      label: "From pay-as-you-go",
      value: trialing
        ? canceled
          ? "None, the plan ends with the trial"
          : "Starts when the trial ends"
        : creditsAndUsd(detail.payg.monthTotal),
    },
    trialing
      ? { label: "Trial ends on", value: trialEndValue(trialEnd, canceled) }
      : { label: "Resets on", value: formatBillingDate(detail.credits.allowanceResetsAt) },
  ]

  return (
    <section className="flex flex-col gap-3" aria-labelledby="billing-credits">
      <SectionLabel>
        <span id="billing-credits">This month</span>
      </SectionLabel>
      <div className="surface-card flex flex-col gap-4 px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-[14.5px] font-medium text-foreground">{meter.label}</span>
          <span className={cn("font-mono text-[13px]", low ? "text-warning" : "text-foreground")}>
            {meter.total === null
              ? `${formatCredits(meter.left)} left`
              : `${formatCredits(meter.left)} of ${formatCredits(meter.total)} left`}
          </span>
        </div>
        {/* The bar is what is left, as the number beside the label. */}
        {meter.total !== null ? <MeterBar percent={100 - meter.percentUsed} tone={low ? "warning" : "primary"} label="Credits left" /> : null}
        <dl className="grid gap-4 sm:grid-cols-3">
          {facts.map((fact) => (
            <div key={fact.label} className="flex min-w-0 flex-col gap-1">
              <dt className={FIELD_LABEL_CLASS}>{fact.label}</dt>
              <dd className="text-[14.5px] text-foreground">{fact.value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-[13px] text-muted-foreground">
          {meter.held > 0 ? `${formatCredits(meter.held)} credits are held for runs in progress. ` : null}1 credit is worth $0.01. A
          failed run costs nothing.
        </p>
      </div>
    </section>
  )
}

/** "Nov 22, 2026", or "Nov 22, 2026 · will not renew" for a canceled trial. */
function trialEndValue(trialEnd: string | null, canceled: boolean): string {
  if (!trialEnd) return "—"
  const date = formatBillingDate(trialEnd)
  return canceled ? `${date} · will not renew` : date
}
