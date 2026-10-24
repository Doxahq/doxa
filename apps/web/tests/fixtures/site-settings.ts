import type { DocsContentOverviewDto } from "@doxahq/contracts"
import { FREE_PLAN_ENTITLEMENTS, resolveSiteConfig } from "@doxahq/site-config"

/** The site settings part of a content overview: free plan, default config. */
export function overviewSiteSettings(): Pick<DocsContentOverviewDto, "entitlements" | "siteConfig"> {
  return {
    entitlements: { ...FREE_PLAN_ENTITLEMENTS },
    siteConfig: { published: resolveSiteConfig({ name: "Docs" }), working: null },
  }
}
