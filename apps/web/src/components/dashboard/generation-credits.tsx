import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { Coins, CreditCard, Loader2, StepForward } from "lucide-react"

import { RollingNumber } from "~/components/dashboard/rolling-number"
import { Button } from "~/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip"
import { formatCredits } from "~/lib/dashboard/billing-model"
import {
  creditsStopAction,
  type GenerationCreditMeter,
  type GenerationCreditsStop,
} from "~/lib/dashboard/generation-credits"

/**
 * The credits of a run (billing spec 10.5), in the generation's summary card:
 * the credits so far, rolling up as the meter reports them, the part that
 * pay-as-you-go pays, and the run's cap as a link to change it. The page
 * draws it only for a meter that is not in shadow mode.
 *
 * The cap is the one that the run (or its last try) started with, so it can
 * differ from the account's cap today. The tooltip says so.
 */
export function GenerationCreditsField({
  meter,
  billingAccountId,
}: {
  meter: GenerationCreditMeter
  /** Null while billing is off or the viewer cannot read the account. */
  billingAccountId: string | null
}) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <span className="inline-flex items-center gap-1.5 font-mono">
        <Coins aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <RollingNumber text={formatCredits(meter.usedCredits)} />
        <span>credits</span>
      </span>
      {meter.paygLine ? <span className="text-[13px] text-muted-foreground">{meter.paygLine}</span> : null}
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <BillingCreditsLink
                billingAccountId={billingAccountId}
                hash="caps"
                className="text-[13px] text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
              >
                {meter.capLine}
              </BillingCreditsLink>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-64 text-xs">{CAP_TOOLTIP}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}

export const CAP_TOOLTIP =
  "The cap that this run started with. A change to your cap applies to new runs, and to this run when you continue it."

/** The credits page of the account, which holds the caps (`#caps`) and the monthly limit (`#payg`). */
function BillingCreditsLink({
  billingAccountId,
  hash,
  className,
  children,
}: {
  billingAccountId: string | null
  hash: "caps" | "payg"
  className?: string
  children: ReactNode
}) {
  return billingAccountId ? (
    <Link to="/dashboard/billing/$accountId/credits" params={{ accountId: billingAccountId }} hash={hash} className={className}>
      {children}
    </Link>
  ) : (
    <Link to="/dashboard/billing" className={className}>
      {children}
    </Link>
  )
}

/**
 * A run that AI credits stopped (billing spec 10.6): why, the credits used,
 * the finished pages, and the way on: raise the limit or the cap on the
 * billing page, then continue the run.
 */
export function GenerationCreditsStopped({
  stop,
  usedCredits,
  message,
  billingAccountId,
  canResume,
  isResuming,
  onResume,
}: {
  stop: GenerationCreditsStop
  /** From the last non-shadow meter event, else null. */
  usedCredits: number | null
  message: string | null
  /** Null while billing is off or the viewer cannot read the account. */
  billingAccountId: string | null
  canResume: boolean
  isResuming: boolean
  onResume: () => void
}) {
  const action = creditsStopAction(stop.reason)
  const title = stop.reason === "credit_cap" ? "The run reached its credit cap" : "The run ran out of AI credits"
  const facts = [
    usedCredits !== null ? `${formatCredits(usedCredits)} credits used.` : null,
    stop.finishedPageCount !== null
      ? `${formatCredits(stop.finishedPageCount)} ${stop.finishedPageCount === 1 ? "page" : "pages"} finished.`
      : null,
  ].filter((fact): fact is string => fact !== null)

  return (
    <section
      role="status"
      aria-labelledby="generation-credits-stopped"
      className="flex flex-col gap-3 border border-warning/35 bg-warning/8 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p id="generation-credits-stopped" className="text-[13.5px] font-medium text-foreground">
          {title}
        </p>
        <p className="text-[13px] leading-5 break-words text-body">
          {[message, ...facts, canResume ? "Continue the run to finish it and keep its pages." : null]
            .filter(Boolean)
            .join(" ")}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" asChild>
          <BillingCreditsLink billingAccountId={billingAccountId} hash={action.hash}>
            <CreditCard aria-hidden="true" />
            {action.label}
          </BillingCreditsLink>
        </Button>
        {canResume ? (
          <Button size="sm" disabled={isResuming} onClick={onResume}>
            {isResuming ? <Loader2 aria-hidden="true" className="animate-spin" /> : <StepForward aria-hidden="true" />}
            {isResuming ? "Continuing…" : "Continue run"}
          </Button>
        ) : null}
      </div>
    </section>
  )
}
