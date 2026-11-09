import type { ReactNode } from "react"

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip"
import { formatExactDate, formatRelativeAge } from "~/lib/dashboard/relative-time"
import { cn } from "~/lib/utils"

/**
 * Text that stands for a date, with the exact date and time on hover.
 * A date can sit outside the dashboard provider, in a test for example, so it brings its own.
 */
export function ExactDateTooltip(props: { date: string; className?: string; children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <time dateTime={props.date} className={cn("cursor-default", props.className)}>
            {props.children}
          </time>
        </TooltipTrigger>
        <TooltipContent className="text-xs">{formatExactDate(props.date)}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** "3 days ago", with the exact date and time on hover. */
export function RelativeDate({ date, className }: { date: string; className?: string }) {
  return (
    <ExactDateTooltip date={date} className={className}>
      {formatRelativeAge(date)}
    </ExactDateTooltip>
  )
}
