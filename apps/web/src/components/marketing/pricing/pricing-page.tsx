import { Band } from "~/components/marketing/band"
import { Hr } from "~/components/marketing/guides"
import { MarketingPage } from "~/components/marketing/marketing-page"
import { SiteFooter } from "~/components/marketing/site-footer"
import { BANDS } from "~/lib/marketing/bands"
import { PricingCompare } from "./pricing-compare"
import { PricingCta } from "./pricing-cta"
import { PricingFaq } from "./pricing-faq"
import { PricingHero } from "./pricing-hero"
import { PricingPlans } from "./pricing-plans"

export function PricingPage() {
  return (
    <MarketingPage page="pricing">
      <PricingHero />
      <Hr label="01 / PLANS" />
      <PricingPlans />
      <Band spec={BANDS.plans} style={{ marginTop: 72 }} />
      <PricingCompare />
      <Hr label="03 / FAQ" />
      <PricingFaq />
      <Band spec={BANDS.beforeCta} />
      <PricingCta />
      <Band spec={BANDS.beforeFooter} />
      <SiteFooter />
    </MarketingPage>
  )
}
