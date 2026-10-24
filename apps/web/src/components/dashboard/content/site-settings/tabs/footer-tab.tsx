import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react"
import type { EditableSiteConfig } from "@doxahq/site-config"

import { Button } from "~/components/ui/button"
import { SettingsSection, TextInput } from "~/components/dashboard/content/site-settings/fields/controls"
import { LinkListField } from "~/components/dashboard/content/site-settings/fields/link-list-field"
import { ValidatedField } from "~/components/dashboard/content/site-settings/fields/validated-field"
import { useSiteSettingsContext } from "~/components/dashboard/content/site-settings/site-settings-context"
import { moveItem, removeItem, replaceItem } from "~/lib/dashboard/site-settings-edits"

type Footer = EditableSiteConfig["footer"]
type Socials = Footer["socials"]

const GROUP_LIMIT = 6
const GROUP_LINK_LIMIT = 12
const SOCIALS: ReadonlyArray<{ key: keyof Socials; label: string; placeholder: string }> = [
  { key: "x", label: "X", placeholder: "https://x.com/acme" },
  { key: "github", label: "GitHub", placeholder: "https://github.com/acme" },
  { key: "linkedin", label: "LinkedIn", placeholder: "https://www.linkedin.com/company/acme" },
  { key: "discord", label: "Discord", placeholder: "https://discord.gg/acme" },
  { key: "youtube", label: "YouTube", placeholder: "https://www.youtube.com/@acme" },
]

export function FooterTab() {
  const { state } = useSiteSettingsContext()
  const { footer } = state.config
  const setFooter = (next: Partial<Footer>) =>
    state.update((current) => ({ ...current, footer: { ...current.footer, ...next } }))
  const setGroups = (groups: Footer["groups"]) => setFooter({ groups })

  return (
    <div className="space-y-8">
      <SettingsSection title="Link groups" description="Columns of links at the bottom of every page.">
        <div className="space-y-4">
          {footer.groups.map((group, index) => {
            const pointer = `/footer/groups/${index}`
            const position = `Group ${index + 1}`
            return (
              <div key={index} className="space-y-3 rounded-lg border border-border p-4" aria-label={position} role="group">
                <div className="flex items-end gap-2">
                  <ValidatedField pointer={`${pointer}/title`} label={`${position} title`} className="flex-1">
                    {(control) => (
                      <TextInput
                        {...control}
                        value={group.title}
                        onValueChange={(title) => setGroups(replaceItem(footer.groups, index, { ...group, title }))}
                        placeholder="Product"
                      />
                    )}
                  </ValidatedField>
                  <Button type="button" variant="ghost" size="icon" disabled={index === 0} onClick={() => setGroups(moveItem(footer.groups, index, index - 1))} aria-label={`Move ${position} up`}>
                    <ArrowUp aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" disabled={index === footer.groups.length - 1} onClick={() => setGroups(moveItem(footer.groups, index, index + 1))} aria-label={`Move ${position} down`}>
                    <ArrowDown aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="hover:text-destructive" onClick={() => setGroups(removeItem(footer.groups, index))} aria-label={`Remove ${position}`}>
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
                <LinkListField
                  pointer={`${pointer}/links`}
                  links={group.links}
                  onChange={(links) => setGroups(replaceItem(footer.groups, index, { ...group, links }))}
                  max={GROUP_LINK_LIMIT}
                  emptyText="No links in this group yet."
                />
              </div>
            )
          })}
          <div className="flex items-center justify-between">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={footer.groups.length >= GROUP_LIMIT}
              onClick={() => setGroups([...footer.groups, { title: "", links: [] }])}
            >
              <Plus aria-hidden="true" />
              Add group
            </Button>
            <span className="font-mono text-[10px] tracking-[0.12em] text-label uppercase">
              {footer.groups.length} of {GROUP_LIMIT}
            </span>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Social links" description="Icons in the footer. Use full https:// links. Leave a field empty to hide its icon.">
        <div className="grid gap-4 md:grid-cols-2">
          {SOCIALS.map(({ key, label, placeholder }) => (
            <ValidatedField key={key} pointer={`/footer/socials/${key}`} label={label}>
              {(control) => (
                <TextInput
                  {...control}
                  value={footer.socials[key] ?? ""}
                  onValueChange={(value) =>
                    setFooter({ socials: { ...footer.socials, [key]: value.trim() === "" ? null : value } })
                  }
                  placeholder={placeholder}
                  className="font-mono text-xs"
                  spellCheck={false}
                />
              )}
            </ValidatedField>
          ))}
        </div>
      </SettingsSection>
    </div>
  )
}
