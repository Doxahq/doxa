import { Hr, Ticks } from "~/components/marketing/guides"
import { SiteNav } from "~/components/marketing/site-nav"
import { DEMO_URL, GET_STARTED_URL } from "~/lib/marketing/links"
import { FOUNDER_PRICE_NOTE } from "~/lib/marketing/pricing"

export function PricingHero() {
  return (
    <header className="hero">
      <div className="hero__glow" aria-hidden="true" />
      <Ticks side="l" ticks={[{ top: 140 }, { top: 226, left: "38%" }, { top: 318 }, { top: 410, left: "22%" }]} />
      <Ticks side="r" ticks={[{ top: 120 }, { top: 210, right: "30%" }, { top: 300 }, { top: 420, right: "50%" }]} />
      <SiteNav current="pricing" />
      <Hr />
      <div className="col">
        <div className="hero__inner">
          <span className="chip">Pricing</span>
          <h1 className="display">
            Docs that update themselves,
            <br />
            <span className="mark">priced to start free</span>
          </h1>
          <p>
            Start with a live docs site on the Free plan. Upgrade when your team needs the Doxa Agent, your own
            branding and higher limits.
          </p>
          <div className="row">
            <a className="btn btn--light" href={GET_STARTED_URL}>
              Start free ›
            </a>
            <a className="btn btn--line" href={DEMO_URL}>
              Talk to us ›
            </a>
          </div>
          <span className="hero__note">
            <i />
            {FOUNDER_PRICE_NOTE}
          </span>
        </div>
      </div>
    </header>
  )
}
