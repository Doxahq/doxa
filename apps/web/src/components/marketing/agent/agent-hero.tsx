import { BranchIcon, EyeIcon, ShieldIcon } from "~/components/marketing/agent/agent-icons"
import { Hr, Ticks } from "~/components/marketing/guides"
import { SiteNav } from "~/components/marketing/site-nav"
import { DOCS_URL, GET_STARTED_URL } from "~/lib/marketing/links"

export function AgentHero() {
  return (
    <header className="hero">
      <div className="hero__glow" aria-hidden="true" />
      <Ticks side="l" ticks={[{ top: 140 }, { top: 232, left: "38%" }, { top: 330 }, { top: 448, left: "22%" }]} />
      <Ticks side="r" ticks={[{ top: 120 }, { top: 214, right: "30%" }, { top: 306 }, { top: 430, right: "50%" }]} />
      <SiteNav current="agent" />
      <Hr />
      <div className="col">
        <div className="hero__inner">
          <span className="chip">
            <b>BETA</b>Doxabot for GitHub
          </span>
          <h1 className="display">
            The AI agent that <span className="mark">documents your code</span>
          </h1>
          <p>
            Connect a GitHub repository. Doxabot reads your code, writes your docs and API reference, and keeps them
            current with every merge.
          </p>
          <div className="row">
            <a className="btn btn--light" href={GET_STARTED_URL}>
              Get started ›
            </a>
            <a className="btn btn--line" href={DOCS_URL}>
              View demo docs ›
            </a>
          </div>
          <ul className="facts-row">
            <li>
              <EyeIcon />
              Read-only repository access
            </li>
            <li>
              <BranchIcon />A preview on every pull request
            </li>
            <li>
              <ShieldIcon />
              You approve every publish
            </li>
          </ul>
        </div>
      </div>
    </header>
  )
}
