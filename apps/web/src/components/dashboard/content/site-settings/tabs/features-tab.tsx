import type { EditableSiteConfig } from "@doxahq/site-config"

import { SettingsSection, SwitchRow } from "~/components/dashboard/content/site-settings/fields/controls"
import { useSiteSettingsContext } from "~/components/dashboard/content/site-settings/site-settings-context"
import { fieldIdForPointer } from "~/lib/dashboard/site-settings-issues"

type Features = EditableSiteConfig["features"]

/**
 * The features a reader can notice. `branding`, `loadFromGithub`, and
 * `AgressiveNavPrefetch` change nothing on a published site, so they are
 * editable only in the JSON tab.
 */
export function FeaturesTab() {
  const { state } = useSiteSettingsContext()
  const { features } = state.config
  const setFeatures = (recipe: (current: Features) => Features) =>
    state.update((current) => ({ ...current, features: recipe(current.features) }))
  const flag = (key: "rightSidebar" | "tableOfContents" | "scrollToTop" | "feedbackEdit" | "apiPlayground" | "rawMarkdown") => ({
    id: fieldIdForPointer(`/features/${key}`),
    checked: features[key],
    onCheckedChange: (checked: boolean) => setFeatures((current) => ({ ...current, [key]: checked })),
  })
  const setAi = (next: Partial<Features["ai"]>) =>
    setFeatures((current) => ({ ...current, ai: { ...current.ai, ...next } }))
  const setCopyPage = (next: Partial<Features["copyPage"]>) =>
    setFeatures((current) => ({ ...current, copyPage: { ...current.copyPage, ...next } }))

  return (
    <div className="space-y-8">
      <SettingsSection title="Page layout">
        <div className="divide-y divide-border">
          <SwitchRow {...flag("rightSidebar")} title="Right sidebar" description="The column on the right of each page, with the table of contents and page actions." />
          <SwitchRow {...flag("tableOfContents")} title="Table of contents" description="The list of headings on the current page." />
          <SwitchRow {...flag("scrollToTop")} title="Scroll to top" description="A button that returns to the top of a long page." />
          <SwitchRow {...flag("feedbackEdit")} title="Feedback and edit links" description="Links that let readers report a problem or suggest an edit." />
        </div>
      </SettingsSection>

      <SettingsSection title="AI assistant">
        <div className="divide-y divide-border">
          <SwitchRow
            id={fieldIdForPointer("/features/ai/chat")}
            title="Chat with the docs"
            description="An assistant that answers questions from this documentation."
            checked={features.ai.chat}
            onCheckedChange={(chat) => setAi({ chat })}
          />
          <SwitchRow
            id={fieldIdForPointer("/features/ai/chatWithPage")}
            title="Ask about this page"
            description={features.ai.chat ? "A page action that starts a chat about the current page." : "Needs 'Chat with the docs'."}
            checked={features.ai.chatWithPage}
            disabled={!features.ai.chat}
            onCheckedChange={(chatWithPage) => setAi({ chatWithPage })}
          />
          <SwitchRow
            id={fieldIdForPointer("/features/ai/floatingInput")}
            title="Floating question bar"
            description={features.ai.chat ? "A question input that stays at the bottom of the page." : "Needs 'Chat with the docs'."}
            checked={features.ai.floatingInput}
            disabled={!features.ai.chat}
            onCheckedChange={(floatingInput) => setAi({ floatingInput })}
          />
        </div>
      </SettingsSection>

      <SettingsSection title="Copy page">
        <div className="divide-y divide-border">
          <SwitchRow
            id={fieldIdForPointer("/features/copyPage/markdown")}
            title="Copy as Markdown"
            description="Copies the page source, for use in an AI tool."
            checked={features.copyPage.markdown}
            onCheckedChange={(markdown) => setCopyPage({ markdown })}
          />
          <SwitchRow
            id={fieldIdForPointer("/features/copyPage/rawText")}
            title="Copy as text"
            description="Copies the page as plain text."
            checked={features.copyPage.rawText}
            onCheckedChange={(rawText) => setCopyPage({ rawText })}
          />
        </div>
      </SettingsSection>

      <SettingsSection title="For developers">
        <div className="divide-y divide-border">
          <SwitchRow {...flag("apiPlayground")} title="API playground" description="Lets readers send requests from API reference pages." />
          <SwitchRow {...flag("rawMarkdown")} title="Markdown routes" description="Serves each page as Markdown at its path with .md added." />
        </div>
      </SettingsSection>
    </div>
  )
}
