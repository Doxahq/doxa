import type { DocsConflict } from "@doxahq/contracts/docs-branches"

import { Button } from "~/components/ui/button"
import { cn } from "~/lib/utils"

type Resolution = "mine" | "main"

export function ConflictRow(props: {
  conflict: DocsConflict
  resolution: Resolution | undefined
  onResolve: (resolution: Resolution) => void
  onCompare: () => void
}) {
  return (
    <article className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-mono text-xs font-bold uppercase">{conflictName(props.conflict)}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{conflictChange(props.conflict)}</p>
          {props.conflict.unit === "structure" ? (
            <p className="mt-1 text-xs text-muted-foreground">
              The navigation and the page list are resolved together.
            </p>
          ) : null}
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={props.onCompare}>
          Compare
        </Button>
      </div>
      <div
        className="inline-flex overflow-hidden rounded-md border border-border"
        role="group"
        aria-label={`Resolve ${conflictName(props.conflict)}`}
      >
        <ResolutionButton
          active={props.resolution === "mine"}
          onClick={() => props.onResolve("mine")}
        >
          Keep mine
        </ResolutionButton>
        <ResolutionButton
          active={props.resolution === "main"}
          onClick={() => props.onResolve("main")}
        >
          Keep main
        </ResolutionButton>
      </div>
    </article>
  )
}

function ResolutionButton(props: {
  active: boolean
  onClick: () => void
  children: string
}) {
  return (
    <button
      type="button"
      aria-pressed={props.active}
      onClick={props.onClick}
      className={cn(
        "px-3 py-1.5 font-mono text-[10px] tracking-[0.1em] uppercase",
        props.active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  )
}

export function conflictName(conflict: DocsConflict): string {
  if (conflict.unit === "page") return conflict.title
  return conflict.unit === "structure" ? "Site structure" : "Site settings"
}

function conflictChange(conflict: DocsConflict): string {
  if (conflict.unit !== "page") return "You changed this · Main changed this"
  return `You ${pastTense(conflict.mine)} · Main ${pastTense(conflict.main)}`
}

function pastTense(value: "modified" | "deleted"): string {
  return value === "modified" ? "edited" : "deleted"
}
