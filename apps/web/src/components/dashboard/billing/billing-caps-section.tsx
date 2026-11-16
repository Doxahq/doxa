import { useState, type FormEvent } from "react"
import type { BillingAccountDetail } from "@doxahq/contracts/billing"

import { SectionDescription, SectionLabel } from "~/components/dashboard/dashboard-header"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { actionDescription, actionLabel, formatCredits, parseCap } from "~/lib/dashboard/billing-model"
import { cn } from "~/lib/utils"

type Cap = BillingAccountDetail["caps"][number]

export interface CapsSectionActions {
  onSave: (action: string, capCredits: number) => Promise<unknown>
  isPending: boolean
  error: string | null
}

/** The most one run of each action can cost (spec 10.5): from `minCap` up to `maxCap`. */
export function BillingCapsSection({ detail, actions }: { detail: BillingAccountDetail; actions: CapsSectionActions }) {
  if (detail.caps.length === 0) return null
  return (
    <section id="caps" className="flex flex-col gap-3" aria-labelledby="billing-caps">
      <div className="flex flex-col gap-1">
        <SectionLabel>
          <span id="billing-caps">Cap per run</span>
        </SectionLabel>
        <SectionDescription>A run stops when it reaches its cap. Continue the run to finish it and keep its pages.</SectionDescription>
        <SectionDescription>Clear cache on the Doxabot page makes the next run cold.</SectionDescription>
      </div>
      <ul className="surface-card">
        {detail.caps.map((cap) => (
          <CapRow key={cap.action} cap={cap} canManage={detail.canManage} actions={actions} />
        ))}
      </ul>
      {actions.error ? <p className="text-[13px] text-destructive">{actions.error}</p> : null}
    </section>
  )
}

function CapRow({ cap, canManage, actions }: { cap: Cap; canManage: boolean; actions: CapsSectionActions }) {
  const [value, setValue] = useState(String(cap.capCredits))
  const [error, setError] = useState<string | null>(null)
  const parsed = parseCap(value, cap.minCap, cap.maxCap)
  const changed = "error" in parsed || parsed.credits !== cap.capCredits
  const inputId = `cap-${cap.action}`
  const noteId = `${inputId}-note`
  const description = actionDescription(cap.action)
  const note = `Base fee ${formatCredits(cap.baseCredits)} credits. Lowest cap ${formatCredits(cap.minCap)} credits.`

  function submit(event: FormEvent): void {
    event.preventDefault()
    if ("error" in parsed) {
      setError(parsed.error)
      return
    }
    setError(null)
    void actions.onSave(cap.action, parsed.credits).catch(() => undefined)
  }

  return (
    <li className="flex flex-col gap-3 border-t border-divider px-5 py-4 first:border-t-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <label htmlFor={inputId} className="text-[14.5px] text-foreground">
            {actionLabel(cap.action)}
          </label>
          {description ? <Badge variant="muted">{description.tag}</Badge> : null}
        </div>
        {description ? (
          <>
            <span className="text-[13px] text-muted-foreground">{description.summary}</span>
            <span className="text-[13px] text-muted-foreground">{description.usedBy}</span>
          </>
        ) : null}
        {/* One line for the note and the error, so an error swaps the text and moves nothing. */}
        <p
          id={noteId}
          role={error ? "alert" : undefined}
          className={cn("mt-2 text-xs", error ? "text-destructive" : "text-muted-foreground")}
        >
          {error ?? note}
        </p>
      </div>
      {canManage ? (
        <form onSubmit={submit} className="flex shrink-0 items-center gap-2">
          <Input
            id={inputId}
            inputMode="numeric"
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              // A new value brings the note back until the next Save.
              setError(null)
            }}
            className="h-8 w-28 font-mono"
            aria-invalid={error ? true : undefined}
            aria-describedby={noteId}
          />
          <span className="text-[13px] text-muted-foreground">credits</span>
          <Button type="submit" variant="outline" size="sm" disabled={actions.isPending || !changed}>
            Save
          </Button>
        </form>
      ) : (
        <span id={inputId} className="font-mono text-[13.5px] text-foreground">
          {formatCredits(cap.capCredits)} credits
        </span>
      )}
    </li>
  )
}
