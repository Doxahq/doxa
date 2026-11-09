import { useState } from "react"
import { Link } from "@tanstack/react-router"
import type { ProjectActivityEvent } from "@doxahq/contracts/project-overview"
import { Bot, CircleX, ClipboardCheck, GitBranch, Upload, type LucideIcon } from "lucide-react"

import { SectionLabel } from "~/components/dashboard/dashboard-header"
import { RelativeDate } from "~/components/dashboard/exact-date-tooltip"
import { Button } from "~/components/ui/button"
import {
  ACTIVITY_FILTERS,
  describeActivityEvent,
  filterActivity,
  type ActivityFilter,
} from "~/lib/dashboard/project-activity-model"
import { cn } from "~/lib/utils"

const EVENT_ICON: Record<ProjectActivityEvent["type"], { icon: LucideIcon; className: string }> = {
  published: { icon: Upload, className: "bg-success/10 text-success" },
  generation_staged: { icon: ClipboardCheck, className: "bg-primary-wash text-primary-text" },
  generation_failed: { icon: CircleX, className: "bg-destructive/10 text-destructive" },
  generation_cancelled: { icon: CircleX, className: "bg-warning/10 text-warning" },
  preview_built: { icon: GitBranch, className: "bg-secondary text-muted-foreground" },
  agent_action: { icon: Bot, className: "bg-primary-wash text-primary-text" },
}

function ActivityRow({ event, projectId }: { event: ProjectActivityEvent; projectId: string }) {
  const { what, detail } = describeActivityEvent(event)
  const { icon: Icon, className } = EVENT_ICON[event.type]
  const generationId = "generationId" in event ? event.generationId : null

  return (
    <div className="flex items-start gap-3 px-4 py-3.5">
      <span className={cn("flex size-[26px] shrink-0 items-center justify-center rounded-md", className)}>
        <Icon aria-hidden="true" className="size-3.5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-[13.5px] text-body">
          <span className="font-medium text-foreground">{event.actor.name}</span> {what}
        </p>
        {detail || generationId ? (
          <p className="flex flex-wrap gap-x-2 text-[12.5px] text-label">
            {detail ? <span>{detail}</span> : null}
            {generationId ? (
              <Link
                to="/dashboard/projects/$projectId/generations/$generationId"
                params={{ projectId, generationId }}
                className="text-link"
              >
                View run
              </Link>
            ) : null}
          </p>
        ) : null}
      </div>
      <RelativeDate date={event.occurredAt} className="shrink-0 font-mono text-[11.5px] text-label" />
    </div>
  )
}

/** The feed of what Doxabot, people and agents did in the project. */
export function ActivityCard(props: {
  projectId: string
  events: readonly ProjectActivityEvent[]
  failed: boolean
}) {
  const [filter, setFilter] = useState<ActivityFilter>("all")
  const events = filterActivity(props.events, filter)
  const emptyMessage = props.failed
    ? "Could not load the activity."
    : props.events.length === 0
      ? "No activity yet."
      : "Nothing matches this filter."

  return (
    <section aria-labelledby="activity-title" className="flex min-w-0 flex-[3_1_30rem] flex-col gap-3">
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
        <SectionLabel>
          <span id="activity-title">Activity</span>
        </SectionLabel>
        <div role="group" aria-label="Filter activity" className="flex gap-0.5">
          {ACTIVITY_FILTERS.map((option) => (
            <Button
              key={option.id}
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={filter === option.id}
              className={cn("h-7 px-2.5 text-[12.5px]", filter === option.id && "bg-secondary text-foreground")}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
      {events.length > 0 ? (
        <ul className="surface-card">
          {events.map((event, index) => (
            <li key={event.id} className={index > 0 ? "border-t border-divider" : undefined}>
              <ActivityRow event={event} projectId={props.projectId} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="surface-card px-4 py-8 text-center text-sm text-muted-foreground">{emptyMessage}</p>
      )}
      <Link
        to="/dashboard/projects/$projectId/generations"
        params={{ projectId: props.projectId }}
        className="self-start text-[13px] text-link"
      >
        View all generations
      </Link>
    </section>
  )
}
