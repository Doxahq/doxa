import { Link } from "@tanstack/react-router"
import { GET_STARTED_URL } from "~/lib/marketing/links"

export function PricingCta() {
  return (
    <section className="col" aria-label="Get started">
      <div className="cta">
        <h2 className="display">Start documenting today</h2>
        <div className="row">
          <a className="btn btn--light" href={GET_STARTED_URL}>
            Start free ›
          </a>
          <Link className="btn btn--line" to="/">
            Back to product ›
          </Link>
        </div>
        <span className="label">Free · Pro · Enterprise · Founder price for the first 100 customers</span>
      </div>
    </section>
  )
}
