import { useState } from "react"
import { docsIconLabel } from "@doxahq/docs-prose/icons"
import { SmilePlus } from "lucide-react"

import { DocsIcon } from "~/components/dashboard/content/docs-icon"
import { IconPickerPanel } from "~/components/dashboard/content/write-editor/icon-picker-panel"
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover"
import { currentIconName, preloadDocsIcons, useLucideIcons } from "~/lib/dashboard/docs-icons"
import { cn } from "~/lib/utils"

export interface PageIconEdit {
  /** The page icon name, or null when the page has none. */
  icon: string | null
  /** Sets or removes the icon. The page shows the new icon at once. */
  onChange: (icon: string | null) => void
}

/**
 * The class that shows the "Add icon" button of a page without an icon. Put
 * it on the element whose hover must reveal it, for example the title block.
 */
export const PAGE_ICON_HOVER_GROUP = "group/page-title"

/**
 * The page icon beside the title, as in Notion. A click opens a dropdown with
 * a search field that has focus, and every Lucide icon in a grid. A page
 * without an icon shows an "Add icon" button on hover.
 */
export function PageIconPicker({
  edit,
  disabled,
  className,
}: {
  edit: PageIconEdit
  disabled: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const icons = useLucideIcons()
  const name = edit.icon ? (currentIconName(edit.icon, icons) ?? edit.icon) : null
  const label = name ? docsIconLabel(name) : null

  function choose(icon: string | null) {
    setOpen(false)
    if (icon !== edit.icon) edit.onChange(icon)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={label ? `Page icon: ${label}. Change icon` : "Add page icon"}
          title={label ? "Change icon" : "Add icon"}
          // The full icon set starts loading as the pointer arrives, so the grid is ready on click.
          onPointerEnter={() => preloadDocsIcons({ tags: true })}
          onFocus={() => preloadDocsIcons({ tags: true })}
          className={cn(
            "grid size-10 shrink-0 place-items-center text-foreground transition-[opacity,background-color] duration-75 hover:bg-overlay focus-visible:opacity-100 disabled:pointer-events-none data-[state=open]:bg-overlay data-[state=open]:opacity-100",
            edit.icon ? "[&_svg]:size-7" : "text-muted-foreground opacity-0 group-hover/page-title:opacity-100 [&_svg]:size-5",
            className,
          )}
        >
          {edit.icon ? (
            <DocsIcon name={edit.icon} strokeWidth={1.75} fallback={<SmilePlus aria-hidden="true" />} />
          ) : (
            <SmilePlus aria-hidden="true" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[320px] p-0">
        <IconPickerPanel value={edit.icon} onSelect={choose} onRemove={edit.icon ? () => choose(null) : undefined} />
      </PopoverContent>
    </Popover>
  )
}
