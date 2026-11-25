import { useState } from "react"
import { Link } from "@tanstack/react-router"

import { SwitchRow } from "~/components/dashboard/content/site-settings/fields/controls"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { analyticsSwitchOn } from "~/lib/analytics/analytics-controller"
import { setAnalyticsConsent } from "~/lib/analytics/browser-analytics"
import { useAnalyticsSnapshot } from "~/lib/analytics/use-analytics-snapshot"

/**
 * "Privacy choices" in a page footer: a plain button that opens the dialog
 * with the one analytics switch. The footer gives it its own link style.
 */
export function PrivacyChoicesButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        Privacy choices
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="shadow-none">{open ? <PrivacyChoicesContent /> : null}</DialogContent>
      </Dialog>
    </>
  )
}

function PrivacyChoicesContent() {
  const snapshot = useAnalyticsSnapshot()
  const accountOff = snapshot.accountOptedOut === true

  return (
    <>
      <DialogHeader>
        <DialogTitle>Privacy choices</DialogTitle>
        <DialogDescription>
          Your choice applies to this browser. Docs sites that we host have no trackers. The{" "}
          <Link to="/legal/privacy" hash="cookies" className="text-foreground underline underline-offset-4">
            Privacy Policy
          </Link>{" "}
          explains what we collect.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="py-2">
        <SwitchRow
          id="privacy-choices-analytics"
          title="Product analytics"
          description={
            accountOff
              ? "Off for your account. Turn it on again in Account settings."
              : "Helps us see how people use doxa.so, so we can fix problems."
          }
          checked={analyticsSwitchOn(snapshot)}
          disabled={accountOff}
          onCheckedChange={(on) => setAnalyticsConsent(on ? "granted" : "denied")}
        />
      </DialogBody>
    </>
  )
}
