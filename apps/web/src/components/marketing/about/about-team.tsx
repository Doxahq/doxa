import { GithubIcon } from "~/components/marketing/about/github-icon"
import { DISCORD_URL, GITHUB_URL } from "~/lib/marketing/links"

const FACTS: [string, string][] = [
  ["Company", "CoderOne Labs"],
  ["Founded", "[FOUNDED YEAR]"],
  ["Based in", "[LOCATION]"],
  ["License", "[LICENSE]"],
  ["Contact", "[YOUR CONTACT EMAIL]"],
]

export function AboutTeam() {
  return (
    <section className="col" aria-label="Who builds Doxa">
      <div className="ab-team">
        <div className="ab-team__copy">
          <span className="label">Who builds it</span>
          <h2 className="display">
            Made at
            <br />
            CoderOne Labs
          </h2>
          <p>
            A small team that builds tools for developers. We build Doxa in the open, so you can
            read the code, file an issue or send a pull request.
          </p>
          <div className="row">
            <a className="btn btn--light btn--sm" href={GITHUB_URL}>
              <GithubIcon />
              Star on GitHub
            </a>
            <a className="btn btn--line btn--sm" href={DISCORD_URL}>
              Join the Discord ›
            </a>
          </div>
        </div>
        <dl className="ab-card vdiv">
          {FACTS.map(([term, value]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}
