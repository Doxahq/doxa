import { AboutBeliefs } from "~/components/marketing/about/about-beliefs"
import { AboutCta } from "~/components/marketing/about/about-cta"
import { AboutHero } from "~/components/marketing/about/about-hero"
import { AboutOpen } from "~/components/marketing/about/about-open"
import { AboutSolve } from "~/components/marketing/about/about-solve"
import { AboutTeam } from "~/components/marketing/about/about-team"
import { AboutWhy } from "~/components/marketing/about/about-why"
import { Band } from "~/components/marketing/band"
import { Hr } from "~/components/marketing/guides"
import { MarketingPage } from "~/components/marketing/marketing-page"
import { SiteFooter } from "~/components/marketing/site-footer"
import { BANDS } from "~/lib/marketing/bands"

/**
 * The "How we solve docs" section is hidden while its art plays in the home hero. To
 * bring it back, set this to true: the section numbers below follow.
 */
const SHOW_SOLVE_SECTION: boolean = false

function sectionLabel(position: number, name: string): string {
  return `${String(position + (SHOW_SOLVE_SECTION ? 1 : 0)).padStart(2, "0")} / ${name}`
}

export function AboutPage() {
  return (
    <MarketingPage page="about">
      <AboutHero />
      {SHOW_SOLVE_SECTION ? (
        <>
          <Hr label="01 / SOLVE" />
          <AboutSolve />
        </>
      ) : null}
      <Hr label={sectionLabel(1, "WHY")} />
      <AboutWhy />
      <Hr label={sectionLabel(2, "OPEN")} />
      <AboutOpen />
      <Hr label={sectionLabel(3, "BELIEFS")} />
      <AboutBeliefs />
      <Hr label={sectionLabel(4, "TEAM")} />
      <AboutTeam />
      <Band spec={BANDS.beforeCta} />
      <AboutCta />
      <Band spec={BANDS.beforeFooter} />
      <SiteFooter />
    </MarketingPage>
  )
}
