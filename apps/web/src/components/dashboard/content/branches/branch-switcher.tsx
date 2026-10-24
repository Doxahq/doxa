import { useEffect, useState, type ReactNode } from "react"
import { Check, ChevronsUpDown, GitBranch, GitCompare, GitMerge, History, Lock, Plus } from "lucide-react"
import type { BranchRef, DocsBranchStatus, NamedDocsBranch } from "@doxahq/contracts/docs-branches"

import {
  BranchEraseRow,
  BranchRenameRow,
  BranchRowActions,
} from "~/components/dashboard/content/branches/branch-row-editors"
import { BranchTag, KeyHints, MenuSectionLabel } from "~/components/dashboard/shell/menu-parts"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "~/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover"
import { branchNameError } from "~/lib/dashboard/branch-name-validation"
import { describeNamedBranch } from "~/lib/dashboard/branch-purpose"
import { ROLE_RESTRICTED_MESSAGE } from "~/lib/dashboard/use-project-capabilities"
import { cn } from "~/lib/utils"

interface BranchSwitcherProps {
  projectId: string
  branch: BranchRef
  branches: readonly NamedDocsBranch[]
  status: DocsBranchStatus | null
  mainChangeCount: number
  maxBranches: number
  disabled?: boolean
  /** False for a role without `docs.write`: no create, rename, erase or compare. */
  canWrite?: boolean
  /** False for a role without `docs.publish`: no merge into main. */
  canPublish?: boolean
  onSelect: (branch: BranchRef) => Promise<void>
  /** Opens the create dialog, filled with the searched name when there is one. */
  onCreate: (name: string) => void
  /** A named branch was erased. The editor moves to main when it was the open one. */
  onBranchErased: (branchId: string) => void
  onHistory: () => void
  /** Opens synchronization with main. */
  onCompare: () => void
  /** Opens the publish flow for the named branch. */
  onMerge: () => void
}

/** The branch card in the Content view, with its search dropdown. ⌘/Ctrl+B toggles it. */
export function BranchSwitcher(props: BranchSwitcherProps) {
  const { canWrite = true, canPublish = true } = props
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  // A branch row being renamed or erased in place.
  const [editing, setEditing] = useState<{ id: string; mode: "rename" | "erase" } | null>(null)
  const selected = props.branches.find(({ id }) => id === props.branch) ?? null
  const isMain = props.branch === "main"
  const changeCount = props.status?.changeCount ?? (isMain ? props.mainChangeCount : selected?.changeCount ?? 0)
  const atLimit = props.branches.length >= props.maxBranches
  const limitMessage = `This plan allows ${props.maxBranches} branches. Erase a branch to create a new one.`
  const trimmed = search.trim()
  const canCreateFromSearch =
    canWrite &&
    trimmed.length > 0 &&
    trimmed !== "main" &&
    !props.branches.some(({ name }) => name === trimmed) &&
    branchNameError(trimmed) === null

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "b" && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
        event.preventDefault()
        if (!props.disabled) setOpen((value) => !value)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [props.disabled])

  useEffect(() => {
    if (!open) {
      setSearch("")
      setEditing(null)
    }
  }, [open])

  // A dialog opens once the popover has closed, so focus returns cleanly.
  function run(action: () => void) {
    setOpen(false)
    requestAnimationFrame(action)
  }

  function switchTo(branch: BranchRef) {
    setOpen(false)
    void props.onSelect(branch)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={props.disabled}
          aria-label={`Branch: ${selected?.name ?? "main"}. Switch branch`}
          className={cn(
            "grid w-full grid-cols-[30px_minmax(0,1fr)_16px] items-center gap-2.5 rounded-md border border-border bg-card px-2.5 py-2 text-left transition-colors",
            "hover:border-border-strong hover:bg-surface-hover data-[state=open]:border-border-strong data-[state=open]:bg-surface-hover disabled:opacity-60",
          )}
        >
          <span className="grid size-[30px] place-items-center rounded-md border border-border bg-background text-primary-text">
            {isMain ? <Lock aria-hidden="true" className="size-4" /> : <GitBranch aria-hidden="true" className="size-4" />}
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-2 font-mono text-[13px] font-medium text-foreground">
              <span className="truncate">{selected?.name ?? "main"}</span>
              {isMain ? (
                <BranchTag tone="live">Live</BranchTag>
              ) : changeCount > 0 ? (
                <BranchTag tone="draft">Draft</BranchTag>
              ) : null}
            </span>
            <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">
              {describeBranchStatus(props.status, changeCount)}
            </span>
          </span>
          <ChevronsUpDown aria-hidden="true" className="size-4 text-faint" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        className="w-[320px] p-0"
        onEscapeKeyDown={(event) => {
          // Escape leaves a rename or an erase confirmation first, then the menu.
          if (editing) {
            event.preventDefault()
            setEditing(null)
          }
        }}
      >
        <Command>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={canWrite ? "Find or create a branch…" : "Find a branch…"}
            className="h-10 font-mono text-[13px]"
          />
          <CommandList className="scrollbar-subtle max-h-[320px] p-1.5">
            <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">
              {canCreateFromSearch ? null : "No branch matches."}
            </CommandEmpty>
            <CommandGroup heading={<MenuSectionLabel>Branches</MenuSectionLabel>}>
              <BranchRow
                value="main production live"
                name="main"
                description="Production · live"
                icon={<Lock aria-hidden="true" className="size-4 text-muted-foreground" />}
                trailing={isMain ? <CurrentMark /> : <BranchTag tone="live">Live</BranchTag>}
                isCurrent={isMain}
                onSelect={() => switchTo("main")}
              />
              {props.branches.map((branch) =>
                editing?.id === branch.id && editing.mode === "rename" ? (
                  <BranchRenameRow key={branch.id} projectId={props.projectId} branch={branch} onDone={() => setEditing(null)} />
                ) : editing?.id === branch.id && editing.mode === "erase" ? (
                  <BranchEraseRow
                    key={branch.id}
                    projectId={props.projectId}
                    branch={branch}
                    onDone={() => setEditing(null)}
                    onErased={() => {
                      setEditing(null)
                      props.onBranchErased(branch.id)
                    }}
                  />
                ) : (
                  <BranchRow
                    key={branch.id}
                    value={`${branch.name} ${branch.id}`}
                    name={branch.name}
                    description={describeNamedBranch(branch)}
                    icon={<GitBranch aria-hidden="true" className="size-4 text-muted-foreground" />}
                    trailing={
                      <span className="flex items-center gap-1">
                        {canWrite ? (
                          <BranchRowActions
                            name={branch.name}
                            onRename={() => setEditing({ id: branch.id, mode: "rename" })}
                            onErase={() => setEditing({ id: branch.id, mode: "erase" })}
                          />
                        ) : null}
                        {branch.id === props.branch ? <CurrentMark /> : null}
                      </span>
                    }
                    isCurrent={branch.id === props.branch}
                    onSelect={() => switchTo(branch.id)}
                  />
                ),
              )}
            </CommandGroup>
            {canCreateFromSearch ? (
              <CommandGroup forceMount>
                <CommandItem
                  forceMount
                  value={`create ${trimmed}`}
                  disabled={atLimit}
                  onSelect={() => run(() => props.onCreate(trimmed))}
                  className="gap-2.5 px-2 py-2"
                >
                  <Plus aria-hidden="true" className="size-4 text-primary-text" />
                  <span className="min-w-0 truncate text-[13px] text-primary-text">
                    Create <span className="font-mono">“{trimmed}”</span> from current
                  </span>
                </CommandItem>
                {atLimit ? <p className="px-2 pb-1 text-xs text-muted-foreground">{limitMessage}</p> : null}
              </CommandGroup>
            ) : null}
            <CommandSeparator className="my-1.5 bg-divider" />
            <CommandGroup>
              {canWrite ? (
                <CommandItem
                  value="new branch create"
                  disabled={atLimit}
                  onSelect={() => run(() => props.onCreate(""))}
                  className="gap-2.5 px-2 py-1.5 text-[13px]"
                  title={atLimit ? limitMessage : undefined}
                >
                  <Plus aria-hidden="true" className="size-4 text-muted-foreground" />
                  New branch…
                </CommandItem>
              ) : null}
              <CommandItem value="history publications" onSelect={() => run(props.onHistory)} className="gap-2.5 px-2 py-1.5 text-[13px]">
                <History aria-hidden="true" className="size-4 text-muted-foreground" />
                History
              </CommandItem>
            </CommandGroup>
          </CommandList>
          <div className="grid grid-cols-2 border-t border-divider">
            <FooterButton
              icon={GitCompare}
              label="Compare"
              disabled={!canWrite || !props.status?.behind}
              title={
                !canWrite
                  ? ROLE_RESTRICTED_MESSAGE
                  : props.status?.behind
                    ? "Synchronize this branch with main"
                    : "This branch is up to date with main."
              }
              onClick={() => run(props.onCompare)}
            />
            <FooterButton
              icon={GitMerge}
              label="Merge into main"
              disabled={!canPublish || isMain || changeCount === 0}
              title={
                !canPublish
                  ? ROLE_RESTRICTED_MESSAGE
                  : isMain
                    ? "Main is the production branch."
                    : changeCount === 0
                      ? "This branch has no changes."
                      : "Publish this branch to main"
              }
              onClick={() => run(props.onMerge)}
              className="border-l border-divider"
            />
          </div>
          <KeyHints hints={["↑↓ navigate", "↵ switch", "⌘B toggle"]} />
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function BranchRow({
  value,
  name,
  description,
  icon,
  trailing,
  isCurrent,
  onSelect,
}: {
  value: string
  name: string
  description: string
  icon: ReactNode
  trailing: ReactNode
  isCurrent: boolean
  onSelect: () => void
}) {
  return (
    <CommandItem
      value={value}
      onSelect={onSelect}
      className={cn("group/row grid grid-cols-[18px_minmax(0,1fr)_auto] gap-2.5 px-2 py-2", isCurrent && "bg-primary-wash")}
    >
      {icon}
      <span className="min-w-0">
        <span className="block truncate font-mono text-[13px] font-medium text-foreground">{name}</span>
        <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">{description}</span>
      </span>
      {trailing}
    </CommandItem>
  )
}

function CurrentMark() {
  return <Check aria-label="Current branch" className="size-4 text-primary-text" />
}

function FooterButton({
  icon: Icon,
  label,
  disabled,
  title,
  onClick,
  className,
}: {
  icon: typeof GitCompare
  label: string
  disabled: boolean
  title: string
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        "flex items-center justify-center gap-2 px-2.5 py-2.5 text-[12.5px] text-foreground transition-colors hover:bg-overlay disabled:pointer-events-none disabled:text-muted-foreground",
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {label}
    </button>
  )
}

/** One short line under the branch name. */
export function describeBranchStatus(status: DocsBranchStatus | null, changeCount: number): string {
  const parts = [changeCount > 0 ? `${changeCount} unpublished` : "No unpublished changes"]
  if (status?.behind) parts.push(`${status.publicationsSinceBase} behind main`)
  return parts.join(" · ")
}
