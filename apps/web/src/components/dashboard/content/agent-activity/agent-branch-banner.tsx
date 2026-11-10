import type { AgentLiveAgent } from "@doxahq/contracts/agent-live-activity"

import { AgentStatusDot } from "~/components/dashboard/content/agent-activity/agent-status-dot"
import { cn } from "~/lib/utils"

/** The strip above the editor while an agent works on the open branch. */
export function AgentBranchBanner({
  agent,
  follow,
  onFollowChange,
}: {
  agent: AgentLiveAgent
  follow: boolean
  onFollowChange: (follow: boolean) => void
}) {
  const waiting = agent.presence === "waiting"
  return (
    <div
      role="status"
      className={cn(
        "flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-4 py-2 text-[13px] text-body",
        waiting ? "bg-warning/8" : "bg-success/7",
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <AgentStatusDot presence={agent.presence} />
        <span className="min-w-0 break-words">
          {waiting
            ? `${agent.clientName} is waiting for your approval.`
            : `${agent.clientName} is editing this branch. Each change appears when it saves. The page is read-only until the agent stops.`}
        </span>
      </span>
      {waiting ? null : (
        <button
          type="button"
          role="switch"
          aria-checked={follow}
          onClick={() => onFollowChange(!follow)}
          className="flex shrink-0 items-center gap-2 text-[12.5px] text-body"
        >
          <span className={cn("relative h-4 w-7 rounded-full transition-colors", follow ? "bg-primary" : "bg-border")}>
            <span
              className={cn(
                "absolute top-0.5 size-3 rounded-full transition-[left]",
                follow ? "left-3.5 bg-primary-foreground" : "left-0.5 bg-muted-foreground",
              )}
            />
          </span>
          Follow the agent
        </button>
      )}
    </div>
  )
}
