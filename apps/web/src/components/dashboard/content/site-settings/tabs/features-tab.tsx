import type { EditableSiteConfig } from "@doxahq/site-config"

import { Select, SettingsSection, SwitchRow, TextInput } from "~/components/dashboard/content/site-settings/fields/controls"
import { EntitlementBadge } from "~/components/dashboard/content/site-settings/fields/entitlement-gate"
import { ValidatedField } from "~/components/dashboard/content/site-settings/fields/validated-field"
import { useSiteSettingsContext } from "~/components/dashboard/content/site-settings/site-settings-context"
import { SHOW_AI_ASSISTANT_SETTINGS } from "~/lib/dashboard/site-settings-flags"
import { fieldIdForPointer } from "~/lib/dashboard/site-settings-issues"

type Features = EditableSiteConfig["features"]
type SearchProviderChoice = NonNullable<Features["searchProvider"]>

const SEARCH_PROVIDER_OPTIONS: readonly { value: SearchProviderChoice; label: string }[] = [
  { value: "typesense", label: "Cloud search (Typesense)" },
  { value: "minisearch", label: "Browser search (MiniSearch)" },
]

const SEARCH_LOCKED_REASON = "Only paid plans can use cloud search. Upgrade the plan to turn it on."

/**
 * The features a reader can notice. `branding`, `loadFromGithub`, and
 * `AgressiveNavPrefetch` change nothing on a published site, so they are
 * editable only in the JSON tab.
 */
export function FeaturesTab() {
  const { state } = useSiteSettingsContext()
  const { features } = state.config
  const isSearchAllowed = (provider: string) => state.searchPolicy.allowedProviders.some((allowed) => allowed === provider)
  // A site that lost its plan keeps its stored choice, but it uses the default.
  const searchProvider =
    features.searchProvider && isSearchAllowed(features.searchProvider)
      ? features.searchProvider
      : state.searchPolicy.defaultProvider
  const isCloudSearchLocked = !isSearchAllowed("typesense")
  const hasLostCloudSearch = isCloudSearchLocked && features.searchProvider === "typesense"
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
  // An empty field removes the setting, which turns Try it off.
  const setPlaygroundBaseUrl = (value: string) =>
    setFeatures(({ apiPlaygroundBaseUrl: _previous, ...current }) =>
      value ? { ...current, apiPlaygroundBaseUrl: value } : current,
    )

  // No setting means the proxy, so only the browser choice is stored.
  const setPlaygroundThroughDoxa = (throughDoxa: boolean) =>
    setFeatures(({ apiPlaygroundTransport: _previous, ...current }) =>
      throughDoxa ? current : { ...current, apiPlaygroundTransport: "browser" },
    )

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

      <SettingsSection title="Search">
        <ValidatedField
          pointer="/features/searchProvider"
          label="Search engine"
          actions={<EntitlementBadge locked={isCloudSearchLocked} reason={SEARCH_LOCKED_REASON} />}
          description={
            hasLostCloudSearch
              ? "This plan does not include cloud search, so this site uses browser search."
              : searchProvider === "typesense"
                ? "Fast on large sites, with stronger typo handling. Readers' search text passes through Doxa to Typesense. It applies after the next publish."
                : "The search index downloads to the reader's browser, and searches stay on the device. It works best up to about 800 pages."
          }
          className="py-3"
        >
          {(control) => (
            <Select
              {...control}
              value={searchProvider}
              options={SEARCH_PROVIDER_OPTIONS.map((option) => ({
                ...option,
                disabled: !isSearchAllowed(option.value),
              }))}
              onValueChange={(next) => setFeatures((current) => ({ ...current, searchProvider: next }))}
            />
          )}
        </ValidatedField>
      </SettingsSection>

      {SHOW_AI_ASSISTANT_SETTINGS && (
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
      )}

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
          <ValidatedField
            pointer="/features/apiPlaygroundBaseUrl"
            label="API base URL"
            description="Where Try it sends requests, for example https://api.acme.com. Readers' API keys go only to this address. Without it, Try it stays off."
            className="py-3"
          >
            {(control) => (
              <TextInput
                {...control}
                value={features.apiPlaygroundBaseUrl ?? ""}
                onValueChange={setPlaygroundBaseUrl}
                placeholder="https://api.example.com"
                disabled={!features.apiPlayground}
                inputMode="url"
                spellCheck={false}
              />
            )}
          </ValidatedField>
          <SwitchRow
            id={fieldIdForPointer("/features/apiPlaygroundTransport")}
            checked={features.apiPlaygroundTransport !== "browser"}
            onCheckedChange={setPlaygroundThroughDoxa}
            disabled={!features.apiPlayground}
            title="Send requests through Doxa"
            description="Your API needs no CORS setup. Readers' keys pass through Doxa and are not stored. Turn this off to send requests from the reader's browser."
          />
          <SwitchRow {...flag("rawMarkdown")} title="Markdown routes" description="Serves each page as Markdown at its path with .md added." />
        </div>
      </SettingsSection>
    </div>
  )
}
