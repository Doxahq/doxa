import { Link } from "@tanstack/react-router"
import { Aurora } from "~/components/marketing/aurora"
import { Hr } from "~/components/marketing/guides"
import { ConnectAgentButton } from "~/components/marketing/home/connect-agent-button"
import { HeroSolve } from "~/components/marketing/home/hero-solve"
import { SiteNav } from "~/components/marketing/site-nav"
import { ctaClickHandler } from "~/lib/analytics/capture-browser-event"
import { GET_STARTED_URL } from "~/lib/marketing/links"

export function HomeHero() {
  return (
    <header className="hero">
      <Aurora dpi={1} />
      <div className="hero__scrim" />

      <SiteNav current="home" />
      <Hr />

      <div className="col">
        <div className="hero__grid">
          {/* Each row draws its top and bottom edges out to the page edge, like baseten.co. */}
          <div className="hero__copy">
            <div className="hero__row">
              <Link className="pill" to="/mcp">
                <b>NEW</b>DOXA MCP SERVER IS LIVE →
              </Link>
            </div>
            <div className="hero__row">
              <h1 className="display">Documentation that updates itself</h1>
            </div>
            <div className="hero__row">
              <p className="hero__lede">
                Open-source platform that keeps your docs in sync with your codebase. An agent writes every page,
                rewrites it on each commit, and asks you before it publishes.
              </p>
            </div>
            <div className="hero__row hero__ctas">
              <a className="btn btn--light" href={GET_STARTED_URL} onClick={ctaClickHandler("home_hero", "get_started")}>
                Get started ›
              </a>
              <ConnectAgentButton location="home_hero" />
            </div>
          </div>
          <HeroSolve />
        </div>
      </div>
    </header>
  )
}
