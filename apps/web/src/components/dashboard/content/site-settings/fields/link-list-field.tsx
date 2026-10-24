import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react"
import type { EditableSiteConfig } from "@doxahq/site-config"

import { Button } from "~/components/ui/button"
import { Switch, TextInput } from "~/components/dashboard/content/site-settings/fields/controls"
import {
  FieldMessages,
  ValidatedField,
} from "~/components/dashboard/content/site-settings/fields/validated-field"
import { useSiteSettingsContext } from "~/components/dashboard/content/site-settings/site-settings-context"
import {
  moveItem,
  removeItem,
  replaceItem,
} from "~/lib/dashboard/site-settings-edits"
import { issuesAt } from "~/lib/dashboard/site-settings-issues"

export type SettingsLink = EditableSiteConfig["navbar"]["links"][number]

interface LinkListFieldProps {
  /** The pointer of the array, for example `/navbar/links`. */
  pointer: string
  links: readonly SettingsLink[]
  onChange: (links: SettingsLink[]) => void
  max: number
  /** Names one item for buttons and screen readers, for example "Link". */
  itemName?: string
  emptyText: string
}

/** An ordered list of links with add, remove, and move controls. */
export function LinkListField({
  pointer,
  links,
  onChange,
  max,
  itemName = "Link",
  emptyText,
}: LinkListFieldProps) {
  const { state } = useSiteSettingsContext()
  const listIssues = issuesAt(state.issues, pointer).filter(state.isIssueVisible)
  const isFull = links.length >= max

  return (
    <div className="space-y-2">
      {links.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
          {emptyText}
        </p>
      ) : (
        <ol className="overflow-hidden rounded-lg border border-border">
          {links.map((link, index) => {
            const itemPointer = `${pointer}/${index}`
            const position = `${itemName} ${index + 1}`
            const set = (next: Partial<SettingsLink>) =>
              onChange(replaceItem(links, index, { ...link, ...next }))
            return (
              <li
                key={index}
                aria-label={position}
                className="grid gap-3 border-t border-border p-3 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]"
              >
                <ValidatedField pointer={`${itemPointer}/label`} label="Label">
                  {(control) => (
                    <TextInput {...control} value={link.label} onValueChange={(label) => set({ label })} placeholder="Blog" />
                  )}
                </ValidatedField>
                <ValidatedField pointer={`${itemPointer}/href`} label="Link">
                  {(control) => (
                    <TextInput
                      {...control}
                      value={link.href}
                      onValueChange={(href) => set({ href })}
                      placeholder="/guides or https://example.com"
                      className="font-mono text-xs"
                      spellCheck={false}
                      inputMode="url"
                    />
                  )}
                </ValidatedField>
                <div className="flex items-end gap-1 pb-0.5">
                  <label className="mr-2 flex h-9 items-center gap-2 text-xs text-muted-foreground">
                    <Switch
                      checked={link.newTab}
                      onCheckedChange={(newTab) => set({ newTab })}
                      aria-label={`${position}: open in a new tab`}
                    />
                    New tab
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    disabled={index === 0}
                    onClick={() => onChange(moveItem(links, index, index - 1))}
                    aria-label={`Move ${position} up`}
                  >
                    <ArrowUp aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    disabled={index === links.length - 1}
                    onClick={() => onChange(moveItem(links, index, index + 1))}
                    aria-label={`Move ${position} down`}
                  >
                    <ArrowDown aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 hover:text-destructive"
                    onClick={() => onChange(removeItem(links, index))}
                    aria-label={`Remove ${position}`}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              </li>
            )
          })}
        </ol>
      )}
      <FieldMessages issues={listIssues} />
      <div className="flex items-center justify-between gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isFull}
          onClick={() => onChange([...links, { label: "", href: "", newTab: false }])}
        >
          <Plus aria-hidden="true" />
          Add {itemName.toLowerCase()}
        </Button>
        <span className="font-mono text-[10px] tracking-[0.12em] text-label uppercase">
          {links.length} of {max}
        </span>
      </div>
    </div>
  )
}
