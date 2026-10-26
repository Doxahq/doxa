import type { DoxabotStatusFact } from "~/lib/dashboard/doxabot-status-model"
import { cn } from "~/lib/utils"

const TONE_DOT: Record<NonNullable<DoxabotStatusFact["tone"]>, string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground",
}

/** The Doxabot facts as one bordered row of cells, stacked on narrow screens. */
export function DoxabotStatusRow({ facts }: { facts: readonly DoxabotStatusFact[] }) {
  return (
    <dl aria-label="Doxabot status" className="surface-card grid grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
      {facts.map((fact) => (
        <div key={fact.label} className="flex min-w-0 flex-col gap-1.5 px-5 py-4">
          <dt className="font-mono text-[10.5px] tracking-[0.14em] text-muted-foreground uppercase">{fact.label}</dt>
          <dd className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
            {fact.tone ? <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[fact.tone])} /> : null}
            <span className={cn("truncate", fact.mono && "font-mono")}>{fact.value}</span>
          </dd>
          <dd className="truncate text-[12.5px] text-muted-foreground">{fact.detail}</dd>
        </div>
      ))}
    </dl>
  )
}
