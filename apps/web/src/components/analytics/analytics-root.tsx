import { ConsentBanner } from "~/components/analytics/consent-banner"
import { useAnalyticsBootstrap } from "~/lib/analytics/use-analytics-bootstrap"

/** Mounted once in the root document: it starts analytics for every page and draws the consent banner. */
export function AnalyticsRoot() {
  useAnalyticsBootstrap()
  return <ConsentBanner />
}
