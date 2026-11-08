import { useState } from "react"
import type { RepositoryBranchesDto } from "@doxahq/contracts"
import { Check, ChevronDown, GitBranch } from "lucide-react"

import { Bar } from "~/components/dashboard/skeletons/skeleton-kit"

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "~/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover"

/** The widths of the placeholder rows while the branches load. */
const LOADING_ROW_WIDTHS = ["5.5rem", "9rem", "7rem", "11rem"] as const

/** The value of the "use the typed name" item. cmdk needs a value that no branch has. */
const TYPED_VALUE_PREFIX = "__typed__:"

interface ProductionBranchPickerProps {
  id?: string
  label: string
  /** The chosen branch name. */
  value: string
  branches: RepositoryBranchesDto | null
  isLoading: boolean
  /** The message of a failed list. The picker then still accepts a typed name. */
  error: string | null
  onValueChange: (branch: string) => void
  disabled?: boolean
}

/**
 * Picks the production branch of a repository: a button that opens a search
 * over the branches, the default branch first. A name that the list does not
 * hold can be typed, because a long list stops at a limit; the API checks on
 * GitHub that the branch exists.
 */
export function ProductionBranchPicker({
  id,
  label,
  value,
  branches,
  isLoading,
  error,
  onValueChange,
  disabled,
}: ProductionBranchPickerProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [highlighted, setHighlighted] = useState(value)
  const names = branches?.branches ?? []
  const typed = search.trim()
  const offerTyped = typed.length > 0 && !/\s/.test(typed) && !names.includes(typed)

  function choose(branch: string) {
    setOpen(false)
    if (branch !== value) onValueChange(branch)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setSearch("")
          setHighlighted(value)
        }
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
          <span className="flex min-w-0 items-center gap-2">
            <GitBranch aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono text-[13px]">{value}</span>
            {branches && value === branches.defaultBranch ? <DefaultTag /> : null}
          </span>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-(--radix-popover-trigger-width) min-w-72 p-0 font-sans">
        <Command loop value={highlighted} onValueChange={setHighlighted}>
          <CommandInput
            autoFocus
            value={search}
            onValueChange={setSearch}
            placeholder="Search or type a branch…"
            className="h-10 text-[13px]"
          />
          <CommandList className="scrollbar-subtle max-h-72 p-1">
            {isLoading ? <LoadingRows /> : null}
            {error ? <p className="px-2 py-3 text-xs text-muted-foreground">{error} You can type a branch name.</p> : null}
            {/* An empty list while it loads is not "no match". */}
            {offerTyped || isLoading ? null : (
              <CommandEmpty className="py-6 text-center text-xs text-muted-foreground">No branch matches.</CommandEmpty>
            )}
            <CommandGroup className="p-0">
              {names.map((name) => (
                <CommandItem
                  key={name}
                  value={name}
                  onSelect={() => choose(name)}
                  className="gap-2 px-2 py-1.5 text-[13px]"
                >
                  <SelectedMark isSelected={name === value} />
                  <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
                  {name === branches?.defaultBranch ? <DefaultTag /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
            {/* Its own forced group: cmdk hides a group whose items all miss the search. */}
            <CommandGroup forceMount className="p-0">
              {offerTyped ? (
                <CommandItem
                  forceMount
                  value={`${TYPED_VALUE_PREFIX}${typed}`}
                  onSelect={() => choose(typed)}
                  className="gap-2 px-2 py-1.5 text-[13px]"
                >
                  <SelectedMark isSelected={false} />
                  <span className="min-w-0 flex-1 truncate">
                    Use <span className="font-mono">{typed}</span>
                  </span>
                </CommandItem>
              ) : null}
            </CommandGroup>
            {branches && !branches.complete && !isLoading ? (
              <p className="px-2 pt-2 pb-1 text-[11px] text-muted-foreground">
                The list shows the first {names.length} branches. Type a name to use another one.
              </p>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Rows with the shape of branch items, so the list does not jump when the
 * names arrive. They need no motion to read as loading.
 */
function LoadingRows() {
  return (
    <div role="status" aria-label="Loading branches" className="flex flex-col">
      {LOADING_ROW_WIDTHS.map((width) => (
        <div key={width} className="flex items-center gap-2 px-2 py-1.5 text-[13px]">
          <span aria-hidden="true" className="size-3.5 shrink-0" />
          <Bar width={width} height="0.8em" className="my-[0.35em]" />
        </div>
      ))}
    </div>
  )
}

/** Only the chosen item draws the check. The others keep its width, so the names line up. */
function SelectedMark({ isSelected }: { isSelected: boolean }) {
  return isSelected ? (
    <Check aria-hidden="true" className="size-3.5 shrink-0 text-primary-text" />
  ) : (
    <span aria-hidden="true" className="size-3.5 shrink-0" />
  )
}

function DefaultTag() {
  return (
    <span className="shrink-0 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">default</span>
  )
}
