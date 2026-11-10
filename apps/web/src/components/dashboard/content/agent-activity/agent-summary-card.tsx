import type { AgentActivitySnapshot, AgentLiveAgent, AgentLiveEvent } from "@doxahq/contracts/agent-live-activity"
import { Link } from "@tanstack/react-router"

import { AgentStatusDot } from "~/components/dashboard/content/agent-activity/agent-status-dot"
import { FIELD_LABEL_CLASS } from "~/components/dashboard/dashboard-header"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  describeCurrentAction,
  describeEvent,
  latestAgentAction,
  latestApprovalRequest,
  presenceLabel,
  timeAgo,
  type PageTitles,
} from "~/lib/dashboard/agent-activity-model"
import { cn } from "~/lib/utils"

function currentCard(agent: AgentLiveAgent, events: readonly AgentLiveEvent[], titles: PageTitles) {
  if (agent.presence === "waiting") {
    const request = latestApprovalRequest(events)
    return {
      label: "Needs your approval",
      title: request?.detail ?? "An agent asked for approval",
      note: request?.note ?? null,
      tint: "bg-warning/8",
      labelTone: "text-warning",
    }
  }
  const action = latestAgentAction(events)
  // Without a pending request, an approval event is already decided.
  if (agent.presence === "active" && action !== undefined && action.kind !== "approval") {
    return {
      label: "Now",
      title: describeCurrentAction(action, titles),
      note: action.note,
      tint: "bg-success/7",
      labelTone: "text-success",
    }
  }
  return {
    label: "Last action",
    title: action === undefined ? "No recent action" : describeEvent(action, titles).title,
    note: action?.note ?? null,
    tint: "bg-secondary",
    labelTone: "",
  }
}

/** Who the agent is, its state, and what it does now. All text from the agent is plain text. */
export function AgentSummaryCard({
  projectId,
  agent,
  events,
  titles,
  serverTime,
  elsewhereBranch,
  onOpenBranch,
}: {
  projectId: string
  /** The agent's branch when the person has another branch open. */
  elsewhereBranch: string | null
  onOpenBranch: (branchId: string) => void
  agent: AgentLiveAgent
  /** This agent's events, newest first. */
  events: readonly AgentLiveEvent[]
  titles: PageTitles
  serverTime: AgentActivitySnapshot["serverTime"]
}) {
  const card = currentCard(agent, events, titles)
  return (
    <div className="flex flex-col gap-3 border-b border-divider px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 break-words text-[15px] font-semibold text-foreground">{agent.clientName}</span>
            <Badge variant="warning">unverified</Badge>
          </div>
          {agent.tokenName === null ? null : (
            <span className="truncate font-mono text-[11px] text-muted-foreground">{agent.tokenName}</span>
          )}
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-body">
          <AgentStatusDot presence={agent.presence} />
          {presenceLabel(agent, serverTime)}
        </span>
      </div>

      <div className={cn("flex flex-col gap-1 rounded-md px-3 py-2.5", card.tint)}>
        <span className={cn(FIELD_LABEL_CLASS, card.labelTone)}>{card.label}</span>
        <span className="break-words text-sm font-medium text-foreground">{card.title}</span>
        {card.note ? <span className="break-words text-[12.5px] text-muted-foreground">{card.note}</span> : null}
        {elsewhereBranch !== null ? (
          <Button type="button" size="sm" className="mt-1.5" onClick={() => onOpenBranch(elsewhereBranch)}>
            Open the agent branch
          </Button>
        ) : null}
        {agent.presence === "waiting" ? (
          <Button asChild size="sm" className="mt-1.5">
            <Link to="/dashboard/projects/$projectId/requests" params={{ projectId }}>
              Review the request
            </Link>
          </Button>
        ) : null}
      </div>

      <span className="font-mono text-[11px] text-muted-foreground">Started {timeAgo(agent.startedAt, serverTime)}</span>
    </div>
  )
}
