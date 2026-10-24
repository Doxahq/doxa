import { AssetUploadField } from "~/components/dashboard/content/site-settings/fields/asset-upload-field"
import { SettingsSection, TextInput } from "~/components/dashboard/content/site-settings/fields/controls"
import { KeywordInput } from "~/components/dashboard/content/site-settings/fields/keyword-field"
import { ValidatedField } from "~/components/dashboard/content/site-settings/fields/validated-field"
import { useSiteSettingsContext } from "~/components/dashboard/content/site-settings/site-settings-context"

const KEYWORD_LIMIT = 20

export function SeoTab() {
  const { state } = useSiteSettingsContext()
  const { seo, branding } = state.config
  const setSeo = (next: Partial<typeof seo>) =>
    state.update((current) => ({ ...current, seo: { ...current.seo, ...next } }))

  return (
    <div className="space-y-8">
      <SettingsSection title="Search" description="The site description on the Branding tab is the default description for search results.">
        <ValidatedField
          pointer="/seo/keywords"
          label="Keywords"
          description={`Up to ${KEYWORD_LIMIT} keywords. Press Enter or a comma to add one.`}
          includeNested
        >
          {(control) => (
            <KeywordInput {...control} keywords={seo.keywords} onChange={(keywords) => setSeo({ keywords })} max={KEYWORD_LIMIT} />
          )}
        </ValidatedField>
      </SettingsSection>

      <SettingsSection title="Social sharing" description="How a link to the docs looks when someone shares it.">
        <AssetUploadField
          pointer="/branding/ogImage"
          kind="ogImage"
          label="Social image"
          value={branding.ogImage}
          onChange={(ogImage) =>
            state.update((current) => ({ ...current, branding: { ...current.branding, ogImage } }))
          }
          hint="1200 × 630 pixels works best on most social sites."
        />
        <ValidatedField pointer="/seo/twitterHandle" label="X handle" description="The account that X credits for shared links.">
          {(control) => (
            <TextInput
              {...control}
              value={seo.twitterHandle}
              onValueChange={(twitterHandle) => setSeo({ twitterHandle })}
              placeholder="@acme"
              spellCheck={false}
            />
          )}
        </ValidatedField>
      </SettingsSection>
    </div>
  )
}
