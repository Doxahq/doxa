import type { AgentPresence } from "@doxahq/contracts/agent-live-activity"
import { Sparkles } from "lucide-react"

import { AgentStatusDot } from "~/components/dashboard/content/agent-activity/agent-status-dot"
import { cn } from "~/lib/utils"

const STATUS_TEXT: Readonly<Record<AgentPresence, string>> = {
  active: "an agent is active",
  waiting: "an agent is waiting for you",
  idle: "an agent is idle",
}

/** The button in the editor top bar. The dot shows the state without opening the panel. */
export function AgentActivityButton({
  presence,
  agentCount,
  open,
  onToggle,
}: {
  presence: AgentPresence | null
  agentCount: number
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={presence === null ? "Agent activity" : `Agent activity: ${STATUS_TEXT[presence]}`}
      title="Agent activity"
      className={cn(
        "flex items-center gap-1.5 rounded-md border border-border px-2.5 py-[7px] font-mono text-[10.5px] font-medium tracking-[0.12em] uppercase transition-colors",
        open
          ? "bg-primary-wash text-primary-text"
          : "bg-card text-muted-foreground hover:bg-overlay hover:text-foreground",
      )}
    >
      <Sparkles aria-hidden="true" className="size-[15px] shrink-0" />
      <span className="max-[980px]:hidden">Agent</span>
      {presence === null ? null : <AgentStatusDot presence={presence} />}
      {agentCount > 1 ? <span className="tracking-normal">{agentCount}</span> : null}
    </button>
  )
}
