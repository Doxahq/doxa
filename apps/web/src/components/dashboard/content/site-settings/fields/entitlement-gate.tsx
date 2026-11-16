import type { ReactNode } from "react"

import { Badge } from "~/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip"

/**
 * Marks a control that needs a paid plan.
 *
 * The control stays visible, so a person can see what an upgrade gives. The
 * caller decides what `locked` disables. For example, a locked switch can still
 * be turned back on, but not off.
 */
export function EntitlementBadge({ locked, reason }: { locked: boolean; reason: string }): ReactNode {
  if (!locked) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="" aria-label={reason}>
          <Badge variant="muted">Paid plans</Badge>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-xs">{reason}</TooltipContent>
    </Tooltip>
  )
}

/**
 * A plan limit that stopped an action (HTTP 403 `plan_limit`, billing spec
 * 9.3): the limit, the use, and one action. A tinted card, not a stripe.
 */
export function PlanLimitGate({
  sentence,
  action,
}: {
  /** "You use 1 of 1 custom domains on Free." */
  sentence: string
  /** The one action: upgrade, or raise the monthly limit. */
  action: ReactNode
}): ReactNode {
  return (
    <div className="flex flex-col gap-3 border border-warning/35 bg-warning/8 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-[13px] leading-5 text-foreground">{sentence}</p>
      <div className="shrink-0">{action}</div>
    </div>
  )
}
