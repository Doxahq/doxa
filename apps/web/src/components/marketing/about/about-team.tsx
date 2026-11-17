import { GithubIcon } from "~/components/marketing/github-icon"
import { CONTACT_EMAIL, GITHUB_URL } from "~/lib/marketing/links"

const FACTS: { term: string; value: string; href?: string }[] = [
  { term: "Company", value: "CoderOne Labs" },
  { term: "Contact", value: CONTACT_EMAIL, href: `mailto:${CONTACT_EMAIL}` },
]

export function AboutTeam() {
  return (
    <section className="col" id="contact" aria-label="Who builds Doxa">
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
          </div>
        </div>
        <dl className="ab-card vdiv">
          {FACTS.map(({ term, value, href }) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{href ? <a href={href}>{value}</a> : value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}
