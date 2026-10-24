import { useMemo, useState } from "react"
import { Check, ChevronDown } from "lucide-react"
import type {
  DocsContentNavigationSectionDto,
  DocsContentPageDto,
} from "@doxahq/contracts"

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "~/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover"
import { buildContentTree } from "~/lib/dashboard/content-navigation"

/** The value of the "no choice" item. cmdk needs a non-empty value for each item. */
const NONE_VALUE = "__none__"

interface PageComboboxProps {
  id?: string
  label: string
  /** The chosen page href, or "" for no choice. */
  value: string
  pages: readonly DocsContentPageDto[]
  navigation: readonly DocsContentNavigationSectionDto[]
  /** The first item, which chooses "". For example "First page (Introduction)". */
  noneLabel: string
  onValueChange: (href: string) => void
  disabled?: boolean
}

/**
 * Picks one docs page: a button that opens a search over the pages, grouped by
 * section in sidebar order. Typing filters by title and by URL. The arrow keys
 * move, Enter picks, and Escape closes.
 */
export function PageCombobox({
  id,
  label,
  value,
  pages,
  navigation,
  noneLabel,
  onValueChange,
  disabled,
}: PageComboboxProps) {
  const [open, setOpen] = useState(false)
  // The highlighted item. It starts on the chosen page each time the list opens.
  const [highlighted, setHighlighted] = useState(value || NONE_VALUE)
  const sections = useMemo(() => buildContentTree(pages, navigation), [navigation, pages])
  const selected = pages.find((page) => page.href === value) ?? null

  function choose(href: string) {
    setOpen(false)
    if (href !== value) onValueChange(href)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setHighlighted(value || NONE_VALUE)
      }}
    >
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          disabled={disabled}
          className="flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-input-background px-3 text-left text-sm text-foreground transition-colors duration-75 outline-none enabled:hover:border-muted-foreground focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:border-muted-foreground"
        >
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate">{selected ? selected.title : noneLabel}</span>
            {selected ? (
              <span className="truncate font-mono text-xs text-muted-foreground">{selected.href}</span>
            ) : null}
          </span>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-(--radix-popover-trigger-width) min-w-72 p-0 font-sans"
      >
        <Command loop value={highlighted} onValueChange={setHighlighted}>
          <CommandInput autoFocus placeholder="Search pages…" className="h-10 text-[13px]" />
          <CommandList className="scrollbar-subtle max-h-80 p-1">
            <CommandEmpty className="py-6 text-center text-xs text-muted-foreground">
              No page matches.
            </CommandEmpty>
            <CommandGroup className="p-0">
              <PageOption
                value={NONE_VALUE}
                keywords={["first", "default", "none", "automatic"]}
                title={noneLabel}
                href={null}
                isSelected={value === ""}
                onSelect={() => choose("")}
              />
            </CommandGroup>
            {sections.map((section) => (
              <CommandGroup
                key={section.slug}
                heading={section.label}
                className="p-0 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:tracking-[0.14em] [&_[cmdk-group-heading]]:text-label [&_[cmdk-group-heading]]:uppercase"
              >
                {section.groups.flatMap((group) =>
                  group.pages.map((page) => (
                    <PageOption
                      key={page.href}
                      value={page.href}
                      keywords={[page.title, ...(group.heading ? [group.heading] : [])]}
                      title={page.title}
                      href={page.href}
                      isSelected={page.href === value}
                      onSelect={() => choose(page.href)}
                    />
                  )),
                )}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function PageOption({
  value,
  keywords,
  title,
  href,
  isSelected,
  onSelect,
}: {
  value: string
  keywords: string[]
  title: string
  href: string | null
  isSelected: boolean
  onSelect: () => void
}) {
  return (
    <CommandItem
      value={value}
      keywords={keywords}
      onSelect={onSelect}
      className="gap-2 px-2 py-1.5 text-[13px]"
    >
      {/* Only the chosen item draws the check. The others keep its width, so the titles line up. */}
      {isSelected ? (
        <Check aria-hidden="true" className="size-3.5 shrink-0 text-primary-text" />
      ) : (
        <span aria-hidden="true" className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {href ? (
        <span className="max-w-[45%] shrink-0 truncate font-mono text-[11px] text-muted-foreground">{href}</span>
      ) : null}
    </CommandItem>
  )
}
