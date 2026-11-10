import type { AgentPresence } from "@doxahq/contracts/agent-live-activity"

import { cn } from "~/lib/utils"

const DOT_CLASS: Readonly<Record<AgentPresence, string>> = {
  active: "bg-success doxa-agent-dot-live",
  waiting: "bg-warning",
  idle: "bg-muted-foreground",
}

export function AgentStatusDot({ presence }: { presence: AgentPresence }) {
  return <span aria-hidden="true" className={cn("size-[7px] shrink-0 rounded-full", DOT_CLASS[presence])} />
}
