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

export function AboutPage() {
  return (
    <MarketingPage page="about">
      <AboutHero />
      <Hr label="01 / SOLVE" />
      <AboutSolve />
      <Hr label="02 / WHY" />
      <AboutWhy />
      <Hr label="03 / OPEN" />
      <AboutOpen />
      <Hr label="04 / BELIEFS" />
      <AboutBeliefs />
      <Hr label="05 / TEAM" />
      <AboutTeam />
      <Band spec={BANDS.beforeCta} />
      <AboutCta />
      <Band spec={BANDS.beforeFooter} />
      <SiteFooter />
    </MarketingPage>
  )
}
