import { BotOff } from "lucide-react"
import type { ReactNode } from "react"

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip"
import { cn } from "~/lib/utils"

const AGENT_LOCK_LABEL = "Agent locked"
const AGENT_LOCK_DESCRIPTION =
  "Generations keep this page as published. You can still edit it. Change this in the page settings."

/**
 * The tooltip that explains an agent lock. A row can sit outside the
 * dashboard provider, in a test for example, so it brings its own.
 */
function AgentLockTooltip({ side, children }: { side: "right" | "bottom"; children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} className="max-w-56 text-xs">
          <span className="font-medium text-foreground">{AGENT_LOCK_LABEL}.</span>{" "}
          <span className="text-muted-foreground">{AGENT_LOCK_DESCRIPTION}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** The mark on a sidebar row of a page that generations keep as published. */
export function AgentLockMark({ className }: { className?: string }) {
  return (
    <AgentLockTooltip side="right">
      {/* The box around the icon gives the pointer a bigger target than the icon. */}
      <span
        role="img"
        aria-label={AGENT_LOCK_LABEL}
        className={cn("flex size-4 shrink-0 items-center justify-center text-muted-foreground", className)}
      >
        <BotOff aria-hidden="true" className="size-3.5" />
      </span>
    </AgentLockTooltip>
  )
}

/** The tag in the editor top bar of a page that generations keep as published. */
export function AgentLockTag({ className }: { className?: string }) {
  return (
    <AgentLockTooltip side="bottom">
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10px] leading-none font-medium tracking-[0.12em] text-muted-foreground uppercase",
          className,
        )}
      >
        <BotOff aria-hidden="true" className="size-3" />
        {AGENT_LOCK_LABEL}
      </span>
    </AgentLockTooltip>
  )
}
