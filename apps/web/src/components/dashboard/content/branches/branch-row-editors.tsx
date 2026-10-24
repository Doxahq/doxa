import { useState, type KeyboardEvent, type MouseEvent } from "react"
import type { NamedDocsBranch } from "@doxahq/contracts/docs-branches"
import { Check, GitBranch, Loader2, Pencil, Trash2, X } from "lucide-react"

import { branchNameError } from "~/lib/dashboard/branch-name-validation"
import { eraseErrorMessage, renameErrorMessage, useBranchActions } from "~/lib/dashboard/use-branch-actions"
import { cn } from "~/lib/utils"

/**
 * Keys typed in a row's own field must not reach the branch list, which would
 * move its highlight or switch branch on Enter.
 */
function keepKeysInField(event: KeyboardEvent) {
  event.stopPropagation()
}

/** A click on a row's own button must not also select the row. */
function onlyThisButton(action: () => void) {
  return (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    action()
  }
}

const ROW_BUTTON_CLASS =
  "grid size-6 place-items-center text-muted-foreground transition-colors hover:bg-overlay hover:text-foreground focus-visible:opacity-100"

/**
 * Rename and erase, on the right of a branch row. They show when the row is
 * hovered or highlighted, so the list reads as names first.
 */
export function BranchRowActions({ name, onRename, onErase }: { name: string; onRename: () => void; onErase: () => void }) {
  return (
    <span className="flex items-center opacity-0 transition-opacity group-hover/row:opacity-100 group-data-[selected=true]/row:opacity-100 focus-within:opacity-100">
      <button type="button" aria-label={`Rename ${name}`} title="Rename" onClick={onlyThisButton(onRename)} className={ROW_BUTTON_CLASS}>
        <Pencil aria-hidden="true" className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={`Erase ${name}`}
        title="Erase"
        onClick={onlyThisButton(onErase)}
        className={cn(ROW_BUTTON_CLASS, "hover:text-danger")}
      >
        <Trash2 aria-hidden="true" className="size-3.5" />
      </button>
    </span>
  )
}

/** The row as a name field. Enter saves, Escape cancels. */
export function BranchRenameRow({
  projectId,
  branch,
  onDone,
}: {
  projectId: string
  branch: NamedDocsBranch
  onDone: () => void
}) {
  const { rename } = useBranchActions(projectId)
  const [name, setName] = useState(branch.name)
  const [attempted, setAttempted] = useState(false)
  const clientError = branchNameError(name)
  const error = rename.error ? renameErrorMessage(rename.error) : attempted ? clientError : null

  function save() {
    setAttempted(true)
    if (name === branch.name) return onDone()
    if (clientError) return
    rename.mutate({ branchId: branch.id, name }, { onSuccess: onDone })
  }

  return (
    <div className="px-2 py-1.5">
      <div className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2.5">
        <GitBranch aria-hidden="true" className="size-4 text-muted-foreground" />
        <input
          value={name}
          autoFocus
          spellCheck={false}
          aria-label={`New name for ${branch.name}`}
          aria-invalid={Boolean(error)}
          onChange={(event) => {
            setName(event.currentTarget.value)
            rename.reset()
          }}
          onKeyDown={(event) => {
            keepKeysInField(event)
            if (event.key === "Enter") save()
            if (event.key === "Escape") onDone()
          }}
          className="h-7 min-w-0 rounded-md border border-input bg-input-background px-2 font-mono text-[13px] text-foreground outline-none focus:border-ring aria-[invalid=true]:border-destructive"
        />
        <span className="flex items-center">
          <button type="button" aria-label="Save the name" title="Save" onClick={save} disabled={rename.isPending} className={ROW_BUTTON_CLASS}>
            {rename.isPending ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin" /> : <Check aria-hidden="true" className="size-3.5" />}
          </button>
          <button type="button" aria-label="Cancel renaming" title="Cancel" onClick={onDone} className={ROW_BUTTON_CLASS}>
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </span>
      </div>
      {error ? <p className="mt-1 pl-[28px] text-xs text-destructive">{error}</p> : null}
    </div>
  )
}

/** The row as an erase confirmation. Erasing drops the branch's unpublished changes. */
export function BranchEraseRow({
  projectId,
  branch,
  onDone,
  onErased,
}: {
  projectId: string
  branch: NamedDocsBranch
  onDone: () => void
  onErased: () => void
}) {
  const { erase } = useBranchActions(projectId)
  return (
    <div className="px-2 py-2" role="group" aria-label={`Erase ${branch.name}`}>
      <p className="text-[12.5px] leading-5 text-foreground">
        Erase <span className="font-mono">{branch.name}</span>? Its unpublished changes and preview are removed.
      </p>
      {erase.error ? <p className="mt-1 text-xs text-destructive">{eraseErrorMessage(erase.error)}</p> : null}
      <div className="mt-2 flex justify-end gap-1.5">
        <button
          type="button"
          autoFocus
          onClick={onDone}
          onKeyDown={keepKeysInField}
          className="px-2.5 py-1 text-[12.5px] text-foreground transition-colors hover:bg-overlay"
        >
          Keep
        </button>
        <button
          type="button"
          disabled={erase.isPending}
          onKeyDown={keepKeysInField}
          onClick={() => erase.mutate(branch.id, { onSuccess: onErased })}
          className="flex items-center gap-1.5 bg-destructive px-2.5 py-1 text-[12.5px] text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-60"
        >
          {erase.isPending ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin" /> : null}
          Erase branch
        </button>
      </div>
    </div>
  )
}
