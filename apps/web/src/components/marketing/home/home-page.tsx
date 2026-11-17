import { Band } from "~/components/marketing/band"
import { Hr } from "~/components/marketing/guides"
import { MarketingPage } from "~/components/marketing/marketing-page"
import { SiteFooter } from "~/components/marketing/site-footer"
import { BANDS } from "~/lib/marketing/bands"
import { HOME_HERO_VERSION } from "~/lib/marketing/home-hero"
import { HomeAgentFeature } from "~/components/marketing/home/home-agent-feature"
import { HomeAgents } from "~/components/marketing/home/home-agents"
import { HomeCta } from "~/components/marketing/home/home-cta"
import { HomeHero } from "~/components/marketing/home/home-hero"
import { HomeHeroV2 } from "~/components/marketing/home/home-hero-v2"
import { HomeImagine } from "~/components/marketing/home/home-imagine"
import { HomeOpen } from "~/components/marketing/home/home-open"
import { HomeProductCards } from "~/components/marketing/home/home-product-cards"
import { HomeProducts } from "~/components/marketing/home/home-products"
import { HomeShowcase } from "~/components/marketing/home/home-showcase"
import { HomeStatement } from "~/components/marketing/home/home-statement"
import { HomeSync } from "~/components/marketing/home/home-sync"

export function HomePage() {
  const heroVersion = HOME_HERO_VERSION
  return (
    <MarketingPage page="home">
      {heroVersion === "v2" ? <HomeHeroV2 /> : <HomeHero />}
      <Hr label="01 / AGENTS" />
      <HomeAgents />
      <Band spec={BANDS.hero} style={{ marginTop: "56px" }} />
      <HomeProducts />
      <Hr label="02 / AGENT" />
      <HomeAgentFeature />
      <Hr />
      <HomeProductCards />
      <Hr label="03 / WHY" />
      <HomeStatement />
      {/* Hero v2 already shows the docs site, so its page leaves out the platform showcase. */}
      {heroVersion === "v1" ? (
        <>
          <Hr />
          <HomeShowcase />
        </>
      ) : null}
      <Hr label="04 / SYNC" />
      <HomeSync />
      <Hr label="05 / OPEN" />
      <HomeOpen />
      <Hr />
      <HomeImagine />
      <Band spec={BANDS.beforeCta} />
      <HomeCta />
      <Band spec={BANDS.beforeFooter} />
      <SiteFooter />
    </MarketingPage>
  )
}
