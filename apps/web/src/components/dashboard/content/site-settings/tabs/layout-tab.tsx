import { docsLayout, type SidebarPosition } from "@doxahq/site-config"

import {
  SegmentedControl,
  SettingsSection,
  SwitchRow,
} from "~/components/dashboard/content/site-settings/fields/controls"
import { ValidatedField } from "~/components/dashboard/content/site-settings/fields/validated-field"
import { useSiteSettingsContext } from "~/components/dashboard/content/site-settings/site-settings-context"
import { withLayout } from "~/lib/dashboard/site-settings-edits"
import { fieldIdForPointer } from "~/lib/dashboard/site-settings-issues"

const SIDEBAR_DESCRIPTION: Record<SidebarPosition, string> = {
  "beside-content":
    "The sidebar sits next to the text, in a page column that stays centered on wide screens.",
  "page-edge":
    "The page fills the window: the sidebar sits at the left edge, the table of contents at the right edge, and the text is centered between them. On wide screens, the section tabs move into the top bar, and the search box moves to its right side.",
}

/** How the docs page is laid out. Part of Appearance. */
export function LayoutTab() {
  const { state } = useSiteSettingsContext()
  const { config, update } = state
  const layout = docsLayout(config)
  const position = layout.sidebar


  return (
    <div className="space-y-8">
      <SettingsSection
        title="Layout"
        description="Where the navigation sits on the docs page. Both look the same on windows narrower than 1440px."
      >
        <ValidatedField pointer="/layout/sidebar" label="Sidebar position" description={SIDEBAR_DESCRIPTION[position]}>
          {(control) => (
            <SegmentedControl
              id={control.id}
              label="Sidebar position"
              value={position}
              options={[
                { value: "beside-content", label: "Beside content" },
                { value: "page-edge", label: "Page edge" },
              ]}
              onValueChange={(sidebar) => update((current) => withLayout(current, { sidebar }))}
            />
          )}
        </ValidatedField>
        <SwitchRow
          id={fieldIdForPointer("/layout/collapsibleGroups")}
          title="Collapsible groups"
          description="Readers can collapse and expand the groups in the sidebar from their heading. Every group starts expanded."
          checked={layout.collapsibleGroups}
          onCheckedChange={(collapsibleGroups) => update((current) => withLayout(current, { collapsibleGroups }))}
        />
      </SettingsSection>
    </div>
  )
}
