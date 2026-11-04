import { useState } from "react"
import { CONTACT_URL, GET_STARTED_URL } from "~/lib/marketing/links"
import {
  BILLING_OPTIONS,
  DEFAULT_BILLING,
  PLANS,
  type BillingPeriod,
  type Plan,
  type PlanAction,
  type PlanPricing,
} from "~/lib/marketing/pricing"
import { RichText } from "./rich-text"

// Upgrading starts in the dashboard too, until checkout exists.
const ACTION_URL: Record<PlanAction, string> = {
  start: GET_STARTED_URL,
  upgrade: GET_STARTED_URL,
  contact: CONTACT_URL,
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
      <strong className="ph" style={{ fontFamily: "var(--display)", fontSize: 44, color: "#fafafa" }}>
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

function BillingToggle({ value, onChange }: { value: BillingPeriod; onChange: (value: BillingPeriod) => void }) {
  return (
    <div className="bill" role="radiogroup" aria-label="Billing period">
      {BILLING_OPTIONS.map((option) => {
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
  const pricing = plan.billing?.[billing] ?? plan
  return (
    <div className={pro ? "plan plan--pro" : "plan"}>
      {pro ? (
        <span
          className="plan__tag chip"
          style={{ background: "#0a0a0a", color: "#9cc2ff", borderColor: "rgba(61, 123, 255, 0.6)" }}
        >
          Founder price
        </span>
      ) : null}
      <div>
        <div className="plan__top">
          <div className="plan__name">{pro ? <span className="mark">{plan.name}</span> : plan.name}</div>
          {plan.billing ? <BillingToggle value={billing} onChange={setBilling} /> : null}
        </div>
        <p className="plan__desc" style={{ marginTop: 10 }}>
          {plan.desc}
        </p>
      </div>
      <PlanPrice pricing={pricing} />
      <p className="price__sub">{pricing.sub}</p>
      {plan.offer ? <p className="price__offer">{plan.offer}</p> : null}
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
        <a className={plan.cta.className} href={ACTION_URL[plan.cta.action]}>
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
