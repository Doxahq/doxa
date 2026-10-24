import { SettingsSection } from "~/components/dashboard/content/site-settings/fields/controls"
import { PageCombobox } from "~/components/dashboard/content/site-settings/fields/page-combobox"
import { ValidatedField } from "~/components/dashboard/content/site-settings/fields/validated-field"
import { useSiteSettingsContext } from "~/components/dashboard/content/site-settings/site-settings-context"
import { contentHomeHref } from "~/lib/dashboard/content-navigation"
import { withHomePage } from "~/lib/dashboard/site-settings-edits"

/** The page that the site root shows. Part of Navigation. */
export function HomePageTab() {
  const { state, readOnly } = useSiteSettingsContext()
  const chosen = state.config.homePage ?? ""
  const firstHref = contentHomeHref(state.pages, state.navigation, null)
  const firstTitle = state.pages.find((page) => page.href === firstHref)?.title

  return (
    <SettingsSection
      title="Default page"
      description="The page that the site root shows. Without a choice, it is the first page of the default section, and it changes when you reorder pages."
    >
      <ValidatedField pointer="/homePage" label="Default page">
        {(control) => (
          <PageCombobox
            id={control.id}
            label="Default page"
            value={chosen}
            pages={state.pages}
            navigation={state.navigation}
            noneLabel={firstTitle ? `First page (${firstTitle})` : "First page"}
            onValueChange={(href) => state.update((current) => withHomePage(current, href))}
            disabled={readOnly}
          />
        )}
      </ValidatedField>
    </SettingsSection>
  )
}
