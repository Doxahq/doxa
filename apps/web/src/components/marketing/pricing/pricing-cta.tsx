import { Link } from "@tanstack/react-router"
import { ctaClickHandler } from "~/lib/analytics/capture-browser-event"
import { GET_STARTED_URL } from "~/lib/marketing/links"
import { FOUNDER_PRICE_NOTE } from "~/lib/marketing/pricing"

export function PricingCta() {
  return (
    <section className="col" aria-label="Get started">
      <div className="cta">
        <h2 className="display">Start documenting today</h2>
        <div className="row">
          <a className="btn btn--light" href={GET_STARTED_URL} onClick={ctaClickHandler("pricing_cta", "get_started")}>
            Start free ›
          </a>
          <Link className="btn btn--line" to="/">
            Back to product ›
          </Link>
        </div>
        <span className="label">Free · Pro · Enterprise · {FOUNDER_PRICE_NOTE}</span>
      </div>
    </section>
  )
}
