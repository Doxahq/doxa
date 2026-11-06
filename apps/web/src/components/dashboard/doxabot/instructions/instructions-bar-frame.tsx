import type { ReactNode } from "react"

import { Button } from "~/components/ui/button"
import type { InstructionsWriteError } from "~/lib/dashboard/use-doxabot-instructions"

/** The bar under the instructions form: a note, the actions, and any save error. */
export function InstructionsBarFrame({
  note,
  actions,
  writeError,
  startError = null,
  onReload,
}: {
  note: string
  actions: ReactNode
  writeError: InstructionsWriteError | null
  startError?: string | null
  onReload: () => void
}) {
  return (
    <div className="surface-card flex flex-col gap-2 px-5 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">{note}</p>
        <div className="flex gap-2">{actions}</div>
      </div>
      {writeError ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-[13px] text-destructive">
          {writeError.message}
          {writeError.stale ? (
            <Button variant="outline" size="sm" onClick={onReload}>
              Reload
            </Button>
          ) : null}
        </p>
      ) : null}
      {startError ? (
        <p role="alert" className="text-[13px] text-destructive">
          {startError}
        </p>
      ) : null}
    </div>
  )
}
