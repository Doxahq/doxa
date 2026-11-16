import { DOXA_CATALOG, isUnlimited } from "@doxahq/billing/catalog"

const freeDomains = DOXA_CATALOG.plans.free.limits["site.custom_domains"]

/** "1 custom domain", from the catalog's Free limit. */
function customDomainsLine(): string {
  if (isUnlimited(freeDomains)) return "unlimited custom domains"
  return `${freeDomains} custom ${freeDomains === 1 ? "domain" : "domains"}`
}

/** The strip at the end of the new project page on Free: what Free includes, and what needs Pro. */
export const FREE_PLAN_NOTE = `Hosting, the editor, ${customDomainsLine()} and MCP are free. Full generations and update runs need Pro.`
