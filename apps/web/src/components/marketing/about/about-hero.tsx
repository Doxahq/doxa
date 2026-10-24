import { HeroTicks } from "~/components/marketing/about/hero-ticks"
import { Aurora } from "~/components/marketing/aurora"
import { Hr } from "~/components/marketing/guides"
import { SiteNav } from "~/components/marketing/site-nav"

const FACTS = ["Open source", "Self-hostable", "No lock-in", "Human-approved"]

export function AboutHero() {
  return (
    <header className="hero">
      <Aurora />
      <div className="hero__scrim" />
      <HeroTicks />
      <SiteNav current="about" />
      <Hr />
      <div className="col">
        <div className="ab-hero">
          <span className="chip">
            <b className="chip__b">ABOUT</b>The team behind Doxa
          </span>
          <h1 className="display">
            Docs should keep up
            <br />
            <span className="mark">with your code</span>
          </h1>
          <p className="hero__lede">
            Doxa is an open-source docs platform from CoderOne Labs that you can self-host. An agent
            writes your docs from the repository, rewrites them on every merge, and asks you before
            anything goes live.
          </p>
          <ul className="ab-facts">
            {FACTS.map((fact) => (
              <li key={fact}>
                <i />
                {fact}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </header>
  )
}
