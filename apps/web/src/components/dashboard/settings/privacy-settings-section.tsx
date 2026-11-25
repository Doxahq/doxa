import { Link } from "@tanstack/react-router"

import { SwitchRow } from "~/components/dashboard/content/site-settings/fields/controls"
import { SectionLabel } from "~/components/dashboard/dashboard-header"
import { usePrivacySettings } from "~/lib/dashboard/use-privacy-settings"

/** Account settings → Privacy: the account's product analytics switch, for every browser. */
export function PrivacySettingsSection() {
  const state = usePrivacySettings()

  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>Privacy</SectionLabel>
      {state.loadError ? (
        <p role="alert" className="surface-card px-5 py-4 text-sm text-destructive">{state.loadError}</p>
      ) : (
        <div className="surface-card px-5">
          <SwitchRow
            id="account-product-analytics"
            title="Product analytics"
            description={
              <>
                Helps us see how people use doxa.so, so we can fix problems. Your choice applies in every browser where
                you sign in. The{" "}
                <Link to="/legal/privacy" hash="collect" className="text-foreground underline underline-offset-4">
                  Privacy Policy
                </Link>{" "}
                explains what we collect.
              </>
            }
            checked={state.productAnalytics ?? false}
            disabled={state.productAnalytics === null}
            onCheckedChange={state.setProductAnalytics}
          />
        </div>
      )}
      {state.saveError ? <p role="alert" className="text-sm text-destructive">{state.saveError}</p> : null}
    </section>
  )
}
