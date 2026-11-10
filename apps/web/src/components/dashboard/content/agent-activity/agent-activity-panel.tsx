import { useState } from "react"
import type { AgentActivitySnapshot, AgentLiveEvent } from "@doxahq/contracts/agent-live-activity"
import { Sparkles, X } from "lucide-react"

import { AgentChangedPages, AgentEventList } from "~/components/dashboard/content/agent-activity/agent-event-list"
import { AgentRevokeControl } from "~/components/dashboard/content/agent-activity/agent-revoke-control"
import { AgentStatusDot } from "~/components/dashboard/content/agent-activity/agent-status-dot"
import { AgentSummaryCard } from "~/components/dashboard/content/agent-activity/agent-summary-card"
import { FIELD_LABEL_CLASS } from "~/components/dashboard/dashboard-header"
import { McpConnectDialog } from "~/components/dashboard/new-project/mcp-connect-dialog"
import { Button } from "~/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs"
import type { AgentActivityConnection } from "~/lib/agent-activity-stream"
import { agentBranchElsewhere, changedPages, type PageTitles } from "~/lib/dashboard/agent-activity-model"
import { cn } from "~/lib/utils"

const TAB_CLASS =
  "h-9 rounded-none border-b border-transparent bg-transparent px-0.5 py-0 font-sans text-[13px] font-medium tracking-normal normal-case data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground"

export interface AgentBranchActions {
  canBuildPreview: boolean
  onBuildPreview: () => void
  /** Null for a member who cannot publish. */
  onReviewChanges: (() => void) | null
}

function NoActivity() {
  const [isConnectOpen, setIsConnectOpen] = useState(false)
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3.5 p-8 text-center">
      <span className="flex size-10 items-center justify-center rounded-md bg-secondary text-muted-foreground">
        <Sparkles aria-hidden="true" className="size-5" />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="font-mono text-xs font-medium tracking-[0.14em] text-foreground uppercase">No agent activity</h2>
        <p className="text-[13.5px] text-muted-foreground">
          Use your external agents, such as Claude Code or Cursor, to update your docs. You can watch each change here.
        </p>
      </div>
      <Button type="button" size="sm" onClick={() => setIsConnectOpen(true)}>
        Connect your agent
      </Button>
      <McpConnectDialog open={isConnectOpen} onOpenChange={setIsConnectOpen} />
    </div>
  )
}

/** Beside the editor, so that the page stays in view while a person watches. */
export function AgentActivityPanel({
  projectId,
  snapshot,
  titles,
  connection,
  openBranch,
  onOpenBranch,
  onReviewEdit,
  branchActions,
  onClose,
}: {
  projectId: string
  snapshot: AgentActivitySnapshot
  titles: PageTitles
  connection: AgentActivityConnection
  openBranch: string
  onOpenBranch: (branchId: string) => void
  /** Shows an edit in the editor. Null ends the review. */
  onReviewEdit: (edit: AgentLiveEvent | null) => void
  /** Null unless an agent works on the branch that the person has open. */
  branchActions: AgentBranchActions | null
  onClose: () => void
}) {
  const [selectedGrantRef, setSelectedGrantRef] = useState<string | null>(null)
  const { agents, serverTime } = snapshot
  const agent = agents.find(({ grantRef }) => grantRef === selectedGrantRef) ?? agents[0] ?? null
  const events = agent === null ? snapshot.events : snapshot.events.filter(({ grantRef }) => grantRef === agent.grantRef)
  const changeCount = changedPages(events, titles).length

  return (
    <aside
      aria-label="Agent activity"
      className="flex w-[400px] shrink-0 flex-col border-l border-border bg-sidebar max-[820px]:absolute max-[820px]:inset-0 max-[820px]:z-30 max-[820px]:w-full max-[820px]:border-l-0"
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-divider pr-2 pl-4">
        <span className={FIELD_LABEL_CLASS}>Agent activity</span>
        <Button type="button" variant="ghost" size="icon" aria-label="Close agent activity" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>

      {connection === "reconnecting" ? (
        <div role="status" className="flex shrink-0 items-center gap-2 bg-warning/8 px-4 py-2 text-[12.5px] text-warning">
          <span aria-hidden="true" className="size-[7px] shrink-0 rounded-full bg-warning" />
          Live updates stopped. Reconnecting. The agent can still make changes.
        </div>
      ) : null}

      {snapshot.events.length === 0 ? (
        <NoActivity />
      ) : (
        <>
          {agents.length > 1 ? (
            <div className="flex flex-col gap-0.5 border-b border-divider p-2">
              {agents.map((candidate) => (
                <button
                  key={candidate.grantRef}
                  type="button"
                  aria-pressed={candidate.grantRef === agent?.grantRef}
                  onClick={() => setSelectedGrantRef(candidate.grantRef)}
                  className={cn(
                    "flex min-h-9 items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-foreground hover:bg-overlay",
                    candidate.grantRef === agent?.grantRef && "bg-secondary",
                  )}
                >
                  <AgentStatusDot presence={candidate.presence} />
                  <span className="min-w-0 truncate">{candidate.clientName}</span>
                </button>
              ))}
            </div>
          ) : null}

          {agent === null ? (
            <p className="border-b border-divider px-4 py-3.5 text-[13px] text-muted-foreground">
              No agent is working on this project now. This is the activity of the last 24 hours.
            </p>
          ) : (
            <AgentSummaryCard
              projectId={projectId}
              agent={agent}
              events={events}
              titles={titles}
              serverTime={serverTime}
              elsewhereBranch={agentBranchElsewhere(snapshot, agent, openBranch)}
              onOpenBranch={onOpenBranch}
            />
          )}

          <Tabs defaultValue="activity" className="flex min-h-0 flex-1 flex-col">
            <TabsList className="h-auto shrink-0 justify-start gap-4 rounded-none border-0 border-b border-divider bg-transparent p-0 px-4">
              <TabsTrigger value="activity" className={TAB_CLASS}>Activity</TabsTrigger>
              <TabsTrigger value="changes" className={TAB_CLASS}>
                Changes <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{changeCount}</span>
              </TabsTrigger>
            </TabsList>
            <TabsContent value="activity" className="mt-0 min-h-0 flex-1 overflow-y-auto scrollbar-subtle">
              <AgentEventList
                projectId={projectId}
                events={events}
                titles={titles}
                serverTime={serverTime}
                openBranch={openBranch}
                onReviewEdit={onReviewEdit}
              />
            </TabsContent>
            <TabsContent value="changes" className="mt-0 min-h-0 flex-1 overflow-y-auto scrollbar-subtle">
              <AgentChangedPages events={events} titles={titles} serverTime={serverTime} />
            </TabsContent>
          </Tabs>

          {branchActions !== null || agent?.canRevoke ? (
            <div className="flex shrink-0 flex-col gap-2 border-t border-divider p-3">
              {branchActions === null ? null : (
                <div className="grid grid-flow-col auto-cols-fr gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!branchActions.canBuildPreview}
                    onClick={branchActions.onBuildPreview}
                  >
                    Build preview
                  </Button>
                  {branchActions.onReviewChanges === null ? null : (
                    <Button type="button" onClick={branchActions.onReviewChanges}>
                      Review changes
                    </Button>
                  )}
                </div>
              )}
              {agent?.canRevoke ? (
                <AgentRevokeControl
                  key={agent.grantRef}
                  projectId={projectId}
                  grantRef={agent.grantRef}
                  agentName={agent.clientName}
                />
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </aside>
  )
}
