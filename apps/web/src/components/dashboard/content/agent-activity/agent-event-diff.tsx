import { useQuery } from "@tanstack/react-query"

import { parseDiffLines, type DiffLineKind } from "~/lib/dashboard/agent-activity-model"
import { REPLAY_MASK_PROPS } from "~/lib/analytics/replay-privacy"
import { agentActivityDiffQueryOptions } from "~/lib/queries/agent-activity"
import { cn } from "~/lib/utils"

const LINE_CLASS: Readonly<Record<DiffLineKind, string>> = {
  add: "bg-success/10 text-foreground",
  remove: "bg-destructive/10 text-foreground",
  context: "text-muted-foreground",
  hunk: "text-label",
}

/** Loads when a person expands the row, so the stream stays small. */
export function AgentEventDiff({ projectId, seq }: { projectId: string; seq: number }) {
  const diff = useQuery(agentActivityDiffQueryOptions(projectId, seq))
  return (
    <div
      {...REPLAY_MASK_PROPS}
      className="mr-4 mb-2 ml-[50px] overflow-x-auto rounded-[5px] border border-divider bg-background py-1.5 font-mono text-[11px] leading-relaxed scrollbar-subtle">
      {diff.isPending ? (
        <p className="px-2 text-muted-foreground">Loading the change…</p>
      ) : diff.isError ? (
        <p className="px-2 text-muted-foreground">This change is no longer available.</p>
      ) : (
        parseDiffLines(diff.data).map((line, index) => (
          <span key={index} className={cn("block px-2 whitespace-pre-wrap break-words", LINE_CLASS[line.kind])}>
            {line.text}
          </span>
        ))
      )}
    </div>
  )
}
