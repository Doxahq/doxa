import { Link } from "@tanstack/react-router"
import { Aurora } from "~/components/marketing/aurora"
import { Hr } from "~/components/marketing/guides"
import { HeroFrisbee } from "~/components/marketing/home/hero-frisbee"
import { SiteNav } from "~/components/marketing/site-nav"
import { DOCS_URL, GET_STARTED_URL } from "~/lib/marketing/links"

export function HomeHero() {
  return (
    <header className="hero">
      <Aurora dpi={1} />
      <div className="hero__scrim" />
      <HeroFrisbee />

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
              <a className="btn btn--light" href={GET_STARTED_URL}>
                Get started ›
              </a>
              <a className="btn btn--line" href={DOCS_URL}>
                View demo docs ›
              </a>
            </div>
          </div>
          <div className="hero__side vdiv">
            <a className="hcard" href="#">
              <span className="hcard__icon hcard__icon--solid">
                <svg width="8" height="8" aria-hidden="true">
                  <rect width="8" height="8" fill="#3D7BFF" />
                </svg>
              </span>
              <span className="hcard__body">
                <span className="hcard__title">
                  Doxa Agent <span className="hcard__tag">BETA</span>
                </span>
                <p>Writes your docs from the repository and rewrites the affected pages on every merge.</p>
              </span>
            </a>
            <a className="hcard" href="#">
              <span className="hcard__icon">
                <svg width="14" height="2" aria-hidden="true">
                  <rect width="14" height="2" fill="#EDEDED" />
                </svg>
              </span>
              <span className="hcard__body">
                <span className="hcard__title">Docs Platform</span>
                <p>Branches, previews and edge publishing for MDX. Search, AI chat and llms.txt built in.</p>
              </span>
            </a>
            <Link className="hcard" to="/mcp">
              <span className="hcard__icon hcard__icon--dotted">
                <svg width="8" height="8" aria-hidden="true">
                  <rect width="8" height="8" fill="#EDEDED" />
                </svg>
              </span>
              <span className="hcard__body">
                <span className="hcard__title">
                  MCP Server <span className="hcard__tag">NEW</span>
                </span>
                <p>Edit docs from Claude, Cursor or Codex. Every publish waits for your approval.</p>
              </span>
            </Link>
          </div>
        </div>
      </div>
    </header>
  )
}
