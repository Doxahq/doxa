import { Band } from "~/components/marketing/band"
import { Hr } from "~/components/marketing/guides"
import { MarketingPage } from "~/components/marketing/marketing-page"
import { McpCatalog } from "~/components/marketing/mcp/mcp-catalog"
import { McpConnect } from "~/components/marketing/mcp/mcp-connect"
import { McpCta } from "~/components/marketing/mcp/mcp-cta"
import { McpFaq } from "~/components/marketing/mcp/mcp-faq"
import { McpHero } from "~/components/marketing/mcp/mcp-hero"
import { McpSafety } from "~/components/marketing/mcp/mcp-safety"
import { McpSignal } from "~/components/marketing/mcp/mcp-signal"
import { McpWorkflow } from "~/components/marketing/mcp/mcp-workflow"
import { SiteFooter } from "~/components/marketing/site-footer"
import { BANDS } from "~/lib/marketing/bands"
import { useCopied } from "~/lib/mcp/copied"

export function McpPage() {
  const copyState = useCopied()
  return (
    <MarketingPage page="mcp">
      <McpHero copyState={copyState} />
      <Hr label="00 / SIGNAL" />
      <McpSignal />
      <Hr label="01 / CONNECT" />
      <McpConnect copyState={copyState} />
      <Hr />
      <Band spec={BANDS.plans} style={{ marginTop: "72px" }} />
      <McpWorkflow />
      <McpSafety />
      <Band spec={BANDS.beforeCta} />
      <McpCatalog />
      <McpFaq />
      <Band spec={BANDS.beforeFooter} />
      <McpCta />
      <Band spec={BANDS.extra} />
      <SiteFooter />
    </MarketingPage>
  )
}
