import { SwitchRow } from "~/components/dashboard/content/site-settings/fields/controls"
import { SectionDescription, SectionLabel } from "~/components/dashboard/dashboard-header"
import { EMAIL_CATEGORY_COPY } from "~/lib/dashboard/email-preferences-model"
import { useEmailPreferences } from "~/lib/dashboard/use-email-preferences"

/** Account settings → Email notifications: one switch for each category. Invites always send. */
export function EmailNotificationsSection() {
  const state = useEmailPreferences()

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <SectionLabel>Email notifications</SectionLabel>
        <SectionDescription>
          The emails that Doxa sends to your account address. Team invites always send.
        </SectionDescription>
      </div>

      {state.isLoading ? (
        <p className="surface-card px-5 py-4 text-sm text-muted-foreground">Loading email settings…</p>
      ) : state.loadError ? (
        <p role="alert" className="surface-card px-5 py-4 text-sm text-destructive">{state.loadError}</p>
      ) : state.preferences ? (
        <div className="surface-card divide-y divide-border px-5">
          {state.preferences.map((preference) => (
            <SwitchRow
              key={preference.category}
              id={`email-notifications-${preference.category}`}
              title={EMAIL_CATEGORY_COPY[preference.category].title}
              description={EMAIL_CATEGORY_COPY[preference.category].description}
              checked={preference.enabled}
              onCheckedChange={(enabled) => state.setEnabled(preference.category, enabled)}
            />
          ))}
        </div>
      ) : null}
      {state.saveError ? <p role="alert" className="text-sm text-destructive">{state.saveError}</p> : null}
    </section>
  )
}
