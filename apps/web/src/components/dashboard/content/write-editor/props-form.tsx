import { Fragment, useId, useState } from "react"
import { docsIconLabel } from "@doxahq/docs-prose/icons"
import { ChevronDown } from "lucide-react"

import { DocsIcon } from "~/components/dashboard/content/docs-icon"
import { SegmentedControl, Select, Switch, TextArea, TextInput } from "~/components/dashboard/content/site-settings/fields/controls"
import { IconPickerPanel } from "~/components/dashboard/content/write-editor/icon-picker-panel"
import { Label } from "~/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover"
import { currentIconName, preloadDocsIcons, useLucideIcons } from "~/lib/dashboard/docs-icons"
import type { PropField, PropValue } from "~/lib/editor/component-props"
import { cn } from "~/lib/utils"

/**
 * The fields of one component's props, built from its definition in
 * `component-props.ts`. Fields with a `section` are grouped under a mono
 * label, and a field with `visibleWhen` shows only while it applies.
 *
 * It is editor chrome: render it outside the site canvas (in a popover or a
 * toolbar), so it keeps the dashboard look.
 */
export function PropsForm({
  fields,
  read,
  onChange,
  className,
}: {
  fields: readonly PropField[]
  read: (field: PropField) => PropValue
  onChange: (field: PropField, value: PropValue) => void
  className?: string
}) {
  const formId = useId()
  const byName = new Map(fields.map((field) => [field.name, field]))
  const visible = fields.filter((field) => {
    if (!field.visibleWhen) return true
    const other = byName.get(field.visibleWhen.name)
    return other ? read(other) === field.visibleWhen.value : true
  })

  return (
    <div className={cn("flex flex-col", className)}>
      {visible.map((field, index) => {
        const startsSection = field.section && field.section !== visible[index - 1]?.section
        return (
          <Fragment key={field.name}>
            {startsSection ? (
              <p
                className={cn(
                  "pb-2.5 font-mono text-[10px] font-medium tracking-[0.14em] text-label uppercase",
                  index > 0 && "mt-4 border-t border-divider pt-4",
                )}
              >
                {field.section}
              </p>
            ) : null}
            <PropRow id={`${formId}-${field.name}`} field={field} value={read(field)} onChange={(value) => onChange(field, value)} />
          </Fragment>
        )
      })}
    </div>
  )
}

function PropRow({
  id,
  field,
  value,
  onChange,
}: {
  id: string
  field: PropField
  value: PropValue
  onChange: (value: PropValue) => void
}) {
  if (field.kind === "boolean") {
    return (
      <div className="flex items-start justify-between gap-4 py-1.5">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={id} className="text-[13px]">
            {field.label}
          </Label>
          {field.description ? <p className="text-xs leading-5 text-muted-foreground">{field.description}</p> : null}
        </div>
        <Switch id={id} checked={value === true} onCheckedChange={onChange} className="mt-0.5" />
      </div>
    )
  }

  const text = String(value)
  return (
    <div className="flex flex-col gap-1.5 py-1.5">
      {field.kind === "icon" ? (
        <span id={id} className="text-[13px] leading-none font-medium">
          {field.label}
        </span>
      ) : (
        <Label htmlFor={id} className="text-[13px]">
          {field.label}
        </Label>
      )}
      <FieldControl id={id} field={field} value={text} onChange={onChange} />
      {field.description ? <p className="text-xs leading-5 text-muted-foreground">{field.description}</p> : null}
    </div>
  )
}

function FieldControl({
  id,
  field,
  value,
  onChange,
}: {
  id: string
  field: Exclude<PropField, { kind: "boolean" }>
  value: string
  onChange: (value: string) => void
}) {
  switch (field.kind) {
    case "enum":
      // A few options read better side by side than in a menu.
      return field.options.length <= 4 ? (
        <SegmentedControl id={id} label={field.label} value={value} options={field.options} onValueChange={onChange} />
      ) : (
        <Select id={id} value={value} options={field.options} onValueChange={onChange} className="h-8" />
      )
    case "icon":
      return <IconPicker labelledBy={id} value={value} onChange={onChange} />
    case "text":
      return field.multiline ? (
        <TextArea id={id} value={value} onValueChange={onChange} placeholder={field.placeholder} rows={2} className="min-h-16" />
      ) : (
        <TextInput id={id} value={value} onValueChange={onChange} placeholder={field.placeholder} className="h-8" />
      )
    case "link":
      return (
        <TextInput
          id={id}
          value={value}
          onValueChange={onChange}
          placeholder={field.placeholder}
          spellCheck={false}
          className="h-8 font-mono text-xs"
        />
      )
  }
}

/** The chosen icon and its name. A click opens the icon picker with every Lucide icon. */
function IconPicker({ labelledBy, value, onChange }: { labelledBy: string; value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false)
  const icons = useLucideIcons()
  const name = value ? (currentIconName(value, icons) ?? value) : null

  function choose(next: string) {
    setOpen(false)
    if (next !== value) onChange(next)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-labelledby={labelledBy}
          aria-description={name ? docsIconLabel(name) : "No icon"}
          onPointerEnter={() => preloadDocsIcons({ tags: true })}
          onFocus={() => preloadDocsIcons({ tags: true })}
          className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border border-input bg-input-background px-2.5 text-left text-[13px] text-foreground transition-colors duration-75 outline-none hover:border-muted-foreground focus-visible:border-muted-foreground"
        >
          {name ? (
            <>
              <DocsIcon name={value} className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{docsIconLabel(name)}</span>
            </>
          ) : (
            <span className="min-w-0 flex-1 truncate text-muted-foreground">No icon</span>
          )}
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[320px] p-0">
        <IconPickerPanel value={value || null} onSelect={choose} onRemove={value ? () => choose("") : undefined} />
      </PopoverContent>
    </Popover>
  )
}
