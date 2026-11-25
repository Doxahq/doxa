import { useState } from "react"
import { Check, Loader2 } from "lucide-react"
import type { BillingInterval } from "@doxahq/billing/catalog"
import type { BillingOffer } from "@doxahq/contracts/billing"

import { BillingIntervalControl } from "~/components/dashboard/billing/billing-interval-control"
import { FIELD_LABEL_CLASS } from "~/components/dashboard/dashboard-header"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { captureBrowserEvent } from "~/lib/analytics/capture-browser-event"
import { PRO_TRIAL_ACTION } from "~/lib/dashboard/ai-access"
import { formatUsd, founderSpotsLine, TRIAL_SENTENCE } from "~/lib/dashboard/billing-model"
import { PRO_TRIAL_DAYS } from "~/lib/dashboard/pro-trial-offer"
import { PRO_FEATURE_GROUPS } from "~/lib/marketing/pricing"

/**
 * Upgrade to Pro through Checkout with the 7-day trial (spec 13). Yearly is
 * the default, with the founder price while the offer is open (spec 7.5). The
 * card shows the price a new Checkout uses now, so Doxa never charges a price
 * the person did not see. The features are the pricing page's two groups.
 * An account that already had a subscription gets no trial, and the card says
 * that Stripe charges at once.
 */
export function BillingUpgradeCard({
  offer,
  canManage,
  trialAvailable,
  isPending,
  error,
  onUpgrade,
}: {
  offer: BillingOffer
  canManage: boolean
  trialAvailable: boolean
  isPending: boolean
  error: string | null
  onUpgrade: (priceKey: string) => void
}) {
  const [interval, setInterval] = useState<BillingInterval>("year")
  const price = offer.prices[interval]
  const spots = founderSpotsLine(offer)
  const trialSentence = trialAvailable ? ` ${TRIAL_SENTENCE}` : ""

  return (
    <section className="surface-card" aria-labelledby="billing-upgrade">
      <div className="flex flex-col gap-5 px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <h2 id="billing-upgrade" className="text-[17px] font-semibold text-foreground">
              Upgrade to Pro
            </h2>
            <p className="flex items-baseline gap-1.5">
              <span className="text-[32px] leading-none font-bold text-foreground">{formatUsd(price.monthlyEquivalentCents)}</span>
              <span className="text-sm text-muted-foreground">/ month</span>
            </p>
            <p className="text-[13px] text-muted-foreground">
              {interval === "year" ? `Billed yearly at ${formatUsd(price.amountCents)}.${trialSentence}` : `Billed monthly.${trialSentence}`}
            </p>
            {offer.open ? (
              <p className="text-[13px] text-primary-text">
                {offer.label}
                {spots ? ` · ${spots}` : null}
              </p>
            ) : null}
          </div>
          <BillingIntervalControl value={interval} onChange={setInterval} yearlySavingsPercent={offer.yearlySavingsPercent} />
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          {PRO_FEATURE_GROUPS.map((group) => (
            <div key={group.id} className="flex min-w-0 flex-col gap-2.5">
              <span className={FIELD_LABEL_CLASS}>{group.label}</span>
              <ul className="flex flex-col gap-2">
                {group.items.map((item) => (
                  <li key={item} className="flex items-center gap-2.5 text-[14px] whitespace-nowrap text-body">
                    <Check aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        {error ? (
          <Alert variant="destructive" aria-live="polite">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-divider px-5 py-4 sm:px-6">
        {canManage ? (
          <>
            <Button
              disabled={isPending}
              onClick={() => {
                captureBrowserEvent("upgrade_clicked", { location: "billing_upgrade_card", interval })
                onUpgrade(price.priceKey)
              }}
            >
              {isPending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
              {trialAvailable ? PRO_TRIAL_ACTION : "Upgrade to Pro"}
            </Button>
            <span className="text-[13px] text-muted-foreground">
              {trialAvailable
                ? `Card required. No charge for ${PRO_TRIAL_DAYS} days.`
                : "This account already had a trial, so Stripe charges the first payment today."}
            </span>
          </>
        ) : (
          <p className="text-[13px] text-muted-foreground">Only an owner or admin of this account can upgrade.</p>
        )}
      </div>
    </section>
  )
}
