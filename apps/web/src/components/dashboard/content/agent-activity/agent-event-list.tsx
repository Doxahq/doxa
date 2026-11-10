import { useState, type ComponentType } from "react"
import type { AgentActivitySnapshot, AgentLiveEvent, AgentLiveEventKind } from "@doxahq/contracts/agent-live-activity"
import { Clock, ExternalLink, Eye, GitBranch, Globe, PenLine, RefreshCw, Search, Upload } from "lucide-react"

import { AgentEventDiff } from "~/components/dashboard/content/agent-activity/agent-event-diff"
import { canOpenEdit, changedPages, describeEvent, timeAgo, type PageTitles } from "~/lib/dashboard/agent-activity-model"
import { cn } from "~/lib/utils"

const KIND_ICON: Readonly<Record<AgentLiveEventKind, ComponentType<{ className?: string }>>> = {
  read: Eye,
  search: Search,
  edit: PenLine,
  branch: GitBranch,
  preview: ExternalLink,
  publish: Upload,
  generation: RefreshCw,
  domain: Globe,
  approval: Clock,
}

const ROW_CLASS = "flex items-start gap-2.5 px-4 py-2.5 text-[13px]"

const KIND_TILE: Partial<Readonly<Record<AgentLiveEventKind, string>>> = {
  edit: "bg-success/12 text-success",
  approval: "bg-warning/12 text-warning",
}

function LineCounts({ added, removed }: { added: number | null; removed: number | null }) {
  if (added === null && removed === null) return null
  return (
    <span className="font-mono text-[11px]">
      <span className="text-success">+{added ?? 0}</span> <span className="text-destructive">−{removed ?? 0}</span>
    </span>
  )
}

function EventRow({
  projectId,
  event,
  titles,
  serverTime,
  selected,
  opensPage,
  onSelect,
}: {
  projectId: string
  event: AgentLiveEvent
  titles: PageTitles
  serverTime: string
  selected: boolean
  opensPage: boolean
  onSelect: () => void
}) {
  const Icon = KIND_ICON[event.kind]
  const { title, detail } = describeEvent(event, titles)
  const content = (
    <>
      <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-[5px] bg-secondary text-muted-foreground", KIND_TILE[event.kind])}>
        <Icon aria-hidden="true" className="size-[13px]" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="break-words text-foreground">{title}</span>
        {detail === null ? null : <span className="truncate text-xs text-muted-foreground">{detail}</span>}
      </span>
      <span className="flex shrink-0 flex-col items-end">
        <LineCounts added={event.linesAdded} removed={event.linesRemoved} />
        <span className="font-mono text-[11px] text-muted-foreground">{timeAgo(event.occurredAt, serverTime)}</span>
      </span>
    </>
  )
  if (!event.hasDiff && !opensPage) return <li className={ROW_CLASS}>{content}</li>
  return (
    <li>
      <button
        type="button"
        aria-expanded={event.hasDiff ? selected : undefined}
        aria-pressed={event.hasDiff ? undefined : selected}
        onClick={onSelect}
        className={cn(ROW_CLASS, "w-full text-left hover:bg-overlay", selected && "bg-overlay")}
      >
        {content}
      </button>
      {selected && event.hasDiff ? <AgentEventDiff projectId={projectId} seq={event.seq} /> : null}
    </li>
  )
}

export function AgentEventList({
  projectId,
  events,
  titles,
  serverTime,
  openBranch,
  onReviewEdit,
}: {
  projectId: string
  events: AgentActivitySnapshot["events"]
  titles: PageTitles
  serverTime: string
  openBranch: string
  onReviewEdit: (edit: AgentLiveEvent | null) => void
}) {
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null)

  function selectEvent(event: AgentLiveEvent) {
    const isSelected = event.seq === selectedSeq
    setSelectedSeq(isSelected ? null : event.seq)
    onReviewEdit(!isSelected && canOpenEdit(event, openBranch, titles) ? event : null)
  }

  return (
    <ol className="py-1.5">
      {events.map((event) => (
        <EventRow
          key={event.seq}
          projectId={projectId}
          event={event}
          titles={titles}
          serverTime={serverTime}
          selected={event.seq === selectedSeq}
          opensPage={canOpenEdit(event, openBranch, titles)}
          onSelect={() => selectEvent(event)}
        />
      ))}
    </ol>
  )
}

export function AgentChangedPages({
  events,
  titles,
  serverTime,
}: {
  events: AgentActivitySnapshot["events"]
  titles: PageTitles
  serverTime: string
}) {
  const pages = changedPages(events, titles)
  if (pages.length === 0) {
    return <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">This agent changed no pages yet.</p>
  }
  return (
    <ul className="py-1.5">
      {pages.map((page) => (
        <li key={page.href} className="flex items-start justify-between gap-3 px-4 py-2.5">
          <span className="flex min-w-0 flex-col">
            <span className="break-words text-[13px] text-foreground">{page.title}</span>
            <span className="truncate font-mono text-[11px] text-muted-foreground">{page.href}</span>
          </span>
          <span className="flex shrink-0 flex-col items-end">
            <LineCounts added={page.linesAdded} removed={page.linesRemoved} />
            <span className="font-mono text-[11px] text-muted-foreground">{timeAgo(page.occurredAt, serverTime)}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}
