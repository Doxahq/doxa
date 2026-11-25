import { AgentArt } from "~/components/marketing/agent/agent-art"
import { AgentFaq } from "~/components/marketing/agent/agent-faq"
import { AgentHero } from "~/components/marketing/agent/agent-hero"
import { AgentInstructions } from "~/components/marketing/agent/agent-instructions"
import { AgentIntegrations } from "~/components/marketing/agent/agent-integrations"
import { AgentOutput } from "~/components/marketing/agent/agent-output"
import { AgentPullRequest } from "~/components/marketing/agent/agent-pull-request"
import { AgentReview } from "~/components/marketing/agent/agent-review"
import { AgentSteps } from "~/components/marketing/agent/agent-steps"
import { AgentTrust } from "~/components/marketing/agent/agent-trust"
import { Band } from "~/components/marketing/band"
import { MarketingPage } from "~/components/marketing/marketing-page"
import { SiteFooter } from "~/components/marketing/site-footer"
import { ctaClickHandler } from "~/lib/analytics/capture-browser-event"
import { BANDS } from "~/lib/marketing/bands"
import { DOCS_URL, GET_STARTED_URL } from "~/lib/marketing/links"

/** The Doxabot page (/agent), from the "Doxa Agent — v11" design frame. */
export function AgentPage() {
  return (
    <MarketingPage page="agent">
      <AgentHero />
      <AgentArt />
      <AgentSteps />
      <Band spec={BANDS.plans} />
      <AgentPullRequest />
      <AgentReview />
      <Band spec={BANDS.extra} />
      <AgentOutput />
      <AgentInstructions />
      <AgentIntegrations />
      <Band spec={BANDS.beforeCta} />
      <section className="col" aria-label="Get started">
        <div className="cta">
          <h2 className="display">
            Ship the code.
            <br />
            <span className="mark">The docs follow.</span>
          </h2>
          <div className="row">
            <a className="btn btn--light" href={GET_STARTED_URL} onClick={ctaClickHandler("agent_cta", "get_started")}>
              Get started ›
            </a>
            <a className="btn btn--line" href={DOCS_URL}>
              View demo docs ›
            </a>
          </div>
          <span className="label">GitHub · Read-only access · You approve every publish</span>
        </div>
      </section>
      <Band spec={BANDS.beforeFooter} />
      <AgentTrust />
      <AgentFaq />
      <SiteFooter />
    </MarketingPage>
  )
}
