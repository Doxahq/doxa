import { Link } from "@tanstack/react-router"
import { GET_STARTED_URL } from "~/lib/marketing/links"

export function HomeCta() {
  return (
    <section className="col" aria-label="Get started">
      <div className="cta">
        <h2 className="display">Start documenting today</h2>
        <div className="row">
          <a className="btn btn--light" href={GET_STARTED_URL}>
            Get started ›
          </a>
          <Link className="btn btn--line" to="/pricing">
            See pricing ›
          </Link>
          <a className="btn btn--line" href="#">
            Book a demo ›
          </a>
        </div>
        <span className="label">Free · Pro · Enterprise · Founder's discount for early signups</span>
      </div>
    </section>
  )
}
