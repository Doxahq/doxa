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
