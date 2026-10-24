import type { ReactNode } from "react"

import { EntitlementBadge } from "~/components/dashboard/content/site-settings/fields/entitlement-gate"
import { AssetUploadField } from "~/components/dashboard/content/site-settings/fields/asset-upload-field"
import {
  SettingsSection,
  SwitchRow,
  TextArea,
  TextInput,
} from "~/components/dashboard/content/site-settings/fields/controls"
import {
  FieldMessages,
  ValidatedField,
} from "~/components/dashboard/content/site-settings/fields/validated-field"
import { useSiteSettingsContext } from "~/components/dashboard/content/site-settings/site-settings-context"
import { describeSiteAssetFiles } from "~/lib/dashboard/site-asset-files"
import { fieldIdForPointer, issuesAt } from "~/lib/dashboard/site-settings-issues"

const POWERED_BY_REASON = "Only paid plans can hide 'Powered by Doxa'. Upgrade the plan to hide it."

/** `afterSite` renders right after the Site section, before the logo. */
export function BrandingTab({ afterSite }: { afterSite?: ReactNode } = {}) {
  const { state } = useSiteSettingsContext()
  const { config, update } = state
  const { branding } = config
  const setBranding = (next: Partial<typeof branding>) =>
    update((current) => ({ ...current, branding: { ...current.branding, ...next } }))
  const setLogo = (next: Partial<typeof branding.logo>) =>
    update((current) => ({
      ...current,
      branding: { ...current.branding, logo: { ...current.branding.logo, ...next } },
    }))
  const isPoweredByLocked = !state.entitlements.removePoweredBy

  return (
    <div className="space-y-8">
      <SettingsSection title="Site" description="The name and summary that the docs site shows in the header, the browser tab, and search results.">
        <ValidatedField pointer="/name" label="Site name">
          {(control) => (
            <TextInput
              {...control}
              value={config.name}
              onValueChange={(name) => update((current) => ({ ...current, name }))}
              maxLength={200}
            />
          )}
        </ValidatedField>
        <ValidatedField pointer="/description" label="Description">
          {(control) => (
            <TextArea
              {...control}
              value={config.description}
              onValueChange={(description) => update((current) => ({ ...current, description }))}
              rows={3}
              // The description holds at most 300 characters, about 7 lines here.
              className="max-h-48"
            />
          )}
        </ValidatedField>
      </SettingsSection>

      {afterSite}

      <SettingsSection title="Logo" description="Upload a logo for each color mode. Without a logo, the site name appears in the header.">
        <div className="space-y-2">
          <div className="grid gap-5 md:grid-cols-2">
            <AssetUploadField
              pointer="/branding/logo/light"
              kind="logo"
              label="Logo for light mode"
              value={branding.logo.light}
              onChange={(light) => setLogo({ light })}
              surface="light"
              showFileRules={false}
            />
            <AssetUploadField
              pointer="/branding/logo/dark"
              kind="logo"
              label="Logo for dark mode"
              value={branding.logo.dark}
              onChange={(dark) => setLogo({ dark })}
              surface="dark"
              showFileRules={false}
            />
          </div>
          {/* Both logos have the same file rules, so they share one note. */}
          <p className="text-xs leading-5 text-muted-foreground">
            Both logos: {describeSiteAssetFiles("logo")}
          </p>
        </div>
        <ValidatedField
          pointer="/branding/logo/href"
          label="Logo link"
          description="Where the logo goes when a reader clicks it. Use / for the docs home page."
        >
          {(control) => (
            <TextInput
              {...control}
              value={branding.logo.href}
              onValueChange={(href) => setLogo({ href })}
              className="font-mono text-xs"
              spellCheck={false}
            />
          )}
        </ValidatedField>
      </SettingsSection>

      <SettingsSection title="Favicon">
        <AssetUploadField
          pointer="/branding/favicon"
          kind="favicon"
          label="Favicon"
          value={branding.favicon}
          onChange={(favicon) => setBranding({ favicon })}
          hint="A square image of 32 × 32 pixels or more."
        />
      </SettingsSection>

      <SettingsSection title="Footer mark">
        <SwitchRow
          id={fieldIdForPointer("/branding/poweredBy")}
          title="Show 'Powered by Doxa'"
          description="A small mark in the footer of every page."
          checked={branding.poweredBy}
          // A locked plan can turn the mark back on, but not off.
          disabled={isPoweredByLocked && branding.poweredBy}
          onCheckedChange={(poweredBy) => setBranding({ poweredBy })}
          badge={<EntitlementBadge locked={isPoweredByLocked} reason={POWERED_BY_REASON} />}
        />
        {/* The switch row has its own label, so only the messages are added. */}
        <FieldMessages issues={issuesAt(state.issues, "/branding/poweredBy").filter(state.isIssueVisible)} />
      </SettingsSection>
    </div>
  )
}
