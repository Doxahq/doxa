import { CONTACT_URL, GET_STARTED_URL } from "~/lib/marketing/links"
import { PLANS, type Plan, type PlanAction } from "~/lib/marketing/pricing"
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

function PlanPrice({ plan }: { plan: Plan }) {
  const strong =
    typeof plan.price === "string" ? (
      <strong>{plan.price}</strong>
    ) : (
      <strong className="ph" style={{ fontFamily: "var(--display)", fontSize: 44, color: "#fafafa" }}>
        {plan.price.ph}
      </strong>
    )
  return (
    <div className="price">
      {strong}
      {plan.per ? <span>{plan.per}</span> : null}
    </div>
  )
}

function PlanCard({ plan }: { plan: Plan }) {
  const pro = plan.id === "pro"
  return (
    <div className={pro ? "plan plan--pro" : "plan"}>
      {pro ? (
        <span
          className="plan__tag chip"
          style={{ background: "#0a0a0a", color: "#9cc2ff", borderColor: "rgba(61, 123, 255, 0.6)" }}
        >
          Founder's discount
        </span>
      ) : null}
      <div>
        <div className="plan__name">{pro ? <span className="mark">{plan.name}</span> : plan.name}</div>
        <p className="plan__desc" style={{ marginTop: 10 }}>
          {plan.desc}
        </p>
      </div>
      <PlanPrice plan={plan} />
      <p className="price__sub">{plan.sub}</p>
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
