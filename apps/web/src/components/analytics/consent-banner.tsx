import { Link } from "@tanstack/react-router"

import { Button } from "~/components/ui/button"
import { shouldShowConsentPrompt } from "~/lib/analytics/analytics-controller"
import { setAnalyticsConsent } from "~/lib/analytics/browser-analytics"
import { useAnalyticsSnapshot } from "~/lib/analytics/use-analytics-snapshot"

/**
 * The analytics consent banner, for visitors in the EEA and the UK and for
 * visitors whose country is unknown. It floats over the bottom of the page,
 * so it never moves the layout, and it renders nothing until the region and
 * the stored choice are known. Accept and Reject have the same size and weight.
 */
export function ConsentBanner() {
  const snapshot = useAnalyticsSnapshot()
  if (!shouldShowConsentPrompt(snapshot)) return null

  return (
    <section
      aria-label="Analytics consent"
      className="surface-card fixed inset-x-4 bottom-4 z-50 flex flex-col gap-3 p-4 font-sans text-sm text-body sm:right-auto sm:max-w-sm"
    >
      <p className="leading-5">
        We use cookies to improve your experience. Read our{" "}
        <Link to="/legal/privacy" hash="cookies" className="text-foreground underline underline-offset-4">
          Privacy Policy
        </Link>{" "}
        for more information.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" size="sm" onClick={() => setAnalyticsConsent("denied")}>
          Reject
        </Button>
        <Button variant="outline" size="sm" onClick={() => setAnalyticsConsent("granted")}>
          Accept
        </Button>
      </div>
    </section>
  )
}
