import { Coins } from "lucide-react"

import { TextBar } from "~/components/dashboard/skeletons/skeleton-kit"
import { Badge } from "~/components/ui/badge"
import { actionLabel, formatCredits } from "~/lib/dashboard/billing-model"
import { COLD_RUN_SENTENCE, type CreditEstimateView, type MeteredRunAction } from "~/lib/dashboard/run-estimate"
import { useCreditEstimate } from "~/lib/dashboard/use-credit-estimate"
import { cn } from "~/lib/utils"

const LINE_CLASS = "text-[13px] leading-5"

/**
 * Hidden since 2026-11-15: no page imports this file, so it is not in the
 * bundle and the dashboard asks for no estimate. The estimate was too far
 * from the real cost (2 of 25 local runs inside the range). Import it again
 * once the estimate has a reliable formula and range.
 *
 * The estimate of the next run. Draws nothing while billing is off, and a
 * bar of the line's size while it loads.
 *
 * `projectId` null is the project that the new project page creates.
 * `showRunType` draws the run panel of the Generate dialogs: the run type
 * (Full generation or Update run) with a COLD tag and the cold sentence when
 * the run has no cache, and the trial cap note.
 */
export function CreditEstimateLine({
  projectId,
  action,
  prefix,
  showRunType = false,
  className,
}: {
  projectId: string | null
  action: MeteredRunAction
  /** For example "Each run:". */
  prefix?: string
  showRunType?: boolean
  className?: string
}) {
  const state = useCreditEstimate(projectId, action, { withRunTemperature: showRunType })
  if (state.kind === "off") return null
  if (state.kind === "loading") {
    return showRunType ? <RunEstimatePanelSkeleton className={className} /> : <TextBar width="75%" className={cn(LINE_CLASS, className)} />
  }
  if (!showRunType) return <CreditEstimateText {...state.view} prefix={prefix} className={className} />
  return <RunEstimatePanel action={action} view={state.view} cold={state.cold === true} prefix={prefix} className={className} />
}

export function CreditEstimateText({
  sentence,
  paygSentence,
  prefix,
  className,
}: {
  sentence: string
  paygSentence: string | null
  prefix?: string
  className?: string
}) {
  return (
    <p className={cn("flex items-start gap-2 text-muted-foreground", LINE_CLASS, className)}>
      <Coins aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>
        {prefix ? `${prefix} ` : null}
        {sentence}
        {paygSentence ? <span className="text-body"> {paygSentence}.</span> : null}
      </span>
    </p>
  )
}

const PANEL_CLASS = "flex flex-col gap-3 rounded-lg border border-border bg-sidebar p-4"

function RunEstimatePanel({
  action,
  view,
  cold,
  prefix,
  className,
}: {
  action: MeteredRunAction
  view: CreditEstimateView
  cold: boolean
  prefix?: string
  className?: string
}) {
  return (
    <section aria-label="AI credits" className={cn(PANEL_CLASS, className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="flex items-center gap-2 text-[13px] font-medium text-foreground">
          {actionLabel(action)}
          {cold ? <Badge variant="muted">Cold</Badge> : null}
        </span>
        {view.trialCreditsLeft !== null ? (
          <span className={cn("text-muted-foreground", LINE_CLASS)}>
            Trial credits left: <span className="text-foreground tabular-nums">{formatCredits(view.trialCreditsLeft)}</span>
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <CreditEstimateText sentence={view.sentence} paygSentence={view.paygSentence} prefix={prefix} />
        {cold ? <p className={cn("pl-5.5 text-muted-foreground", LINE_CLASS)}>{COLD_RUN_SENTENCE}</p> : null}
      </div>
      {view.trialNote ? (
        <p className={cn("rounded-md bg-warning/8 px-3 py-2 text-warning", LINE_CLASS)}>{view.trialNote}</p>
      ) : null}
    </section>
  )
}

/** The run type and estimate lines' boxes, so the panel takes its space before the estimate arrives. */
function RunEstimatePanelSkeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn(PANEL_CLASS, className)}>
      <TextBar width="9rem" className={LINE_CLASS} />
      <div className="flex flex-col gap-1">
        <TextBar width="70%" className={LINE_CLASS} />
        <TextBar width="90%" className={LINE_CLASS} />
      </div>
    </div>
  )
}
