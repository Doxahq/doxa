import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { DEMO_URL, GET_STARTED_URL } from "~/lib/marketing/links"
import {
  DEFAULT_BILLING,
  DEFAULT_PRO_OFFER,
  FOUNDER_OFFER_KEY,
  PLANS,
  billingOptions,
  founderOfferLine,
  proPricing,
  upgradeUrl,
  type BillingPeriod,
  type OfferPrices,
  type Plan,
  type PlanAction,
  type PlanPricing,
} from "~/lib/marketing/pricing"
import { billingOffersQueryOptions, isBillingNotConfigured } from "~/lib/queries/billing"
import { RichText } from "./rich-text"

/**
 * "Start trial" opens sign-up with the trial in the URL, then Checkout. Only when
 * the API answers that it takes no payments (503 `billing_not_configured`) does the
 * button fall back to plain sign-up, so it never leads to a billing error page. The
 * link keeps the trial while the offers load, and when they fail for another reason
 * (network, CORS), so a quick click never loses it.
 */
function actionUrl(action: PlanAction, billing: BillingPeriod, paymentsOpen: boolean): string {
  if (action === "upgrade") return paymentsOpen ? upgradeUrl(billing, GET_STARTED_URL) : GET_STARTED_URL
  return action === "contact" ? DEMO_URL : GET_STARTED_URL
}

/** The live Pro offer from `GET /billing/offers` (spec 7.5). Until it answers, or if it fails, the catalog prices. */
function useProOffer() {
  const offersQuery = useQuery(billingOffersQueryOptions())
  const live = offersQuery.data?.find((offer) => offer.offerKey === FOUNDER_OFFER_KEY) ?? null
  const paymentsOpen = !(offersQuery.isError && isBillingNotConfigured(offersQuery.error))
  return { prices: (live ?? DEFAULT_PRO_OFFER) as OfferPrices, live, paymentsOpen }
}

function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M2.5 7.5l3 3 6-7" />
    </svg>
  )
}

function PlanPrice({ pricing }: { pricing: PlanPricing }) {
  const strong =
    typeof pricing.price === "string" ? (
      <strong>{pricing.price}</strong>
    ) : (
      <strong className="ph" style={{ fontFamily: "var(--display)", fontSize: 44, color: "var(--heading)" }}>
        {pricing.price.ph}
      </strong>
    )
  return (
    <div className="price">
      {strong}
      {pricing.per ? <span>{pricing.per}</span> : null}
    </div>
  )
}

function BillingToggle({
  value,
  offer,
  onChange,
}: {
  value: BillingPeriod
  offer: OfferPrices
  onChange: (value: BillingPeriod) => void
}) {
  return (
    <div className="bill" role="radiogroup" aria-label="Billing period">
      {billingOptions(offer).map((option) => {
        const on = option.id === value
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={on}
            className={on ? "bill__opt bill__opt--on" : "bill__opt"}
            onClick={() => onChange(option.id)}
          >
            {option.label}
            {option.note ? <span>{option.note}</span> : null}
          </button>
        )
      })}
    </div>
  )
}

function PlanCard({ plan }: { plan: Plan }) {
  const pro = plan.id === "pro"
  const [billing, setBilling] = useState<BillingPeriod>(DEFAULT_BILLING)
  const offer = useProOffer()
  const livePricing = pro ? proPricing(offer.prices) : plan.billing
  const pricing = livePricing?.[billing] ?? plan
  const offerLine = pro ? (offer.live ? founderOfferLine(offer.live) : plan.offer) : plan.offer
  return (
    <div className={pro ? "plan plan--pro" : "plan"}>
      {pro && (offer.live?.open ?? true) ? (
        <span
          className="plan__tag chip"
          style={{ background: "var(--night)", color: "var(--ice)", borderColor: "rgba(61, 123, 255, 0.6)" }}
        >
          Founder price
        </span>
      ) : null}
      <div>
        <div className="plan__top">
          <div className="plan__name">{pro ? <span className="mark">{plan.name}</span> : plan.name}</div>
          {plan.billing ? <BillingToggle value={billing} offer={offer.prices} onChange={setBilling} /> : null}
        </div>
        <p className="plan__desc" style={{ marginTop: 10 }}>
          {plan.desc}
        </p>
      </div>
      <PlanPrice pricing={pricing} />
      <p className="price__sub">{pricing.sub}</p>
      {offerLine ? <p className="price__offer">{offerLine}</p> : null}
      <h4>{plan.includes}</h4>
      <ul className="checks">
        {plan.checks.map((runs, i) => (
          <li key={i}>
            <Check />
            {/* Mixed runs sit in one span so the flex gap does not split them. */}
            {runs.length === 1 ? (
              <RichText runs={runs} />
            ) : (
              <span>
                <RichText runs={runs} />
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="plan__foot">
        <div className="hosts">
          {plan.hosts.map((host) => (
            <span key={host.label} className={host.lav ? "host host--lav" : "host"}>
              {host.label}
            </span>
          ))}
        </div>
        <a className={plan.cta.className} href={actionUrl(plan.cta.action, billing, offer.paymentsOpen)}>
          {plan.cta.label}
        </a>
      </div>
    </div>
  )
}

export function PricingPlans() {
  return (
    <section className="col" aria-label="Plans">
      <div className="plans">
        {PLANS.map((plan) => (
          <PlanCard key={plan.id} plan={plan} />
        ))}
      </div>
    </section>
  )
}
