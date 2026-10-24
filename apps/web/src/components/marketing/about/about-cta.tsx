import { DISCORD_URL, GET_STARTED_URL, GITHUB_URL } from "~/lib/marketing/links"

export function AboutCta() {
  return (
    <section className="col" aria-label="Get started">
      <div className="cta">
        <h2 className="display">Build it with us</h2>
        <div className="row">
          <a className="btn btn--light" href={GET_STARTED_URL}>
            Get started ›
          </a>
          <a className="btn btn--line" href={GITHUB_URL}>
            Star on GitHub ›
          </a>
          <a className="btn btn--line" href={DISCORD_URL}>
            Join the Discord ›
          </a>
        </div>
        <span className="label">Open source · Self-hostable · Issues and pull requests welcome</span>
      </div>
    </section>
  )
}
