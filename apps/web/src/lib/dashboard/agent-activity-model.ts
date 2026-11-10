import {
  AGENT_ACTIVE_WINDOW_MS,
  AGENT_APPROVAL_DECISION_TOOL,
  AGENT_SESSION_GAP_MS,
  agentPresence,
  type AgentActivitySnapshot,
  type AgentActivityStreamMessage,
  type AgentLiveAgent,
  type AgentLiveEvent,
  type AgentLiveEventKind,
  type AgentPresence,
} from "@doxahq/contracts/agent-live-activity"

export type PageTitles = ReadonlyMap<string, string>

export interface EventDescription {
  title: string
  detail: string | null
}

export interface ChangedPage {
  href: string
  title: string
  occurredAt: string
  linesAdded: number
  linesRemoved: number
}

export type DiffLineKind = "add" | "remove" | "context" | "hunk"

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

const MAX_KEPT_EVENTS = 100

const PRESENCE_PRIORITY: readonly AgentPresence[] = ["waiting", "active", "idle"]

/** The state that the Agent button shows when several agents work on a project. */
export function strongestPresence(agents: readonly AgentLiveAgent[]): AgentPresence | null {
  return PRESENCE_PRIORITY.find((presence) => agents.some((agent) => agent.presence === presence)) ?? null
}

export function presenceLabel(agent: AgentLiveAgent, serverTime: string): string {
  if (agent.presence === "waiting") return "Waiting for you"
  return agent.presence === "active" ? "Active" : `Idle, ${timeAgo(agent.lastEventAt, serverTime)}`
}

/**
 * Pure: the snapshot as it is at `nowMs` on the server's clock. Presence comes
 * from the age of the last event, so it must not wait for a server message.
 */
export function snapshotAt(snapshot: AgentActivitySnapshot, nowMs: number): AgentActivitySnapshot {
  const now = new Date(nowMs)
  return {
    ...snapshot,
    serverTime: now.toISOString(),
    agents: snapshot.agents.flatMap((agent) => {
      const presence = agentPresence({
        lastEventAt: new Date(agent.lastEventAt),
        hasPendingApproval: agent.presence === "waiting",
        now,
      })
      return presence === null ? [] : [{ ...agent, presence }]
    }),
  }
}

/** Pure: the time until age alone changes the presence of an agent. Null when it cannot. */
export function msUntilPresenceChanges(agents: readonly AgentLiveAgent[], nowMs: number): number | null {
  const delays = agents.flatMap(({ presence, lastEventAt }) => {
    if (presence === "waiting") return []
    const age = nowMs - Date.parse(lastEventAt)
    // An idle agent stays listed up to and including the end of the session.
    return [presence === "active" ? AGENT_ACTIVE_WINDOW_MS - age : AGENT_SESSION_GAP_MS - age + 1]
  })
  return delays.length === 0 ? null : Math.max(0, Math.min(...delays))
}

function pageName(event: AgentLiveEvent, titles: PageTitles): string {
  if (event.pageTitle !== null) return event.pageTitle
  if (event.pageHref === null) return "a page"
  return titles.get(event.pageHref) ?? event.pageHref
}

const FIXED_TITLES: Readonly<Record<string, string>> = {
  get_docs_structure: "Read the page list",
  get_site_settings: "Read the site settings",
  get_branch_diff: "Read the branch changes",
  search_docs: "Searched the docs",
  update_site_settings: "Changed the site settings",
  upload_asset: "Added an image",
  finish_asset_upload: "Added an image",
  create_branch: "Created a branch",
  delete_branch: "Deleted a branch",
  sync_branch: "Synced a branch",
  build_preview: "Built a preview",
}

/** These tools repeat their name in `detail`, so the row shows it once. */
const TITLES_WITH_DETAIL: ReadonlySet<string> = new Set([
  "search_docs",
  "upload_asset",
  "finish_asset_upload",
  "create_branch",
])

function editTitle(event: AgentLiveEvent, titles: PageTitles): string {
  if (event.pageHref !== null || event.pageTitle !== null) return `Edited ${pageName(event, titles)}`
  return event.detail === "Site structure" ? "Changed the site structure" : `Edited ${event.detail ?? "the docs"}`
}

/** What the event did, in the past tense. */
export function describeEvent(event: AgentLiveEvent, titles: PageTitles): EventDescription {
  const fixed = FIXED_TITLES[event.tool]
  if (fixed !== undefined) {
    return { title: fixed, detail: TITLES_WITH_DETAIL.has(event.tool) ? event.detail : null }
  }
  if (event.tool === AGENT_APPROVAL_DECISION_TOOL) return { title: `${event.detail ?? "Decided"} by a person`, detail: null }
  if (event.tool === "read_page") return { title: `Read ${pageName(event, titles)}`, detail: null }
  if (event.kind === "edit") return { title: editTitle(event, titles), detail: null }
  if (event.kind === "approval") return { title: "Asked for approval", detail: event.detail }
  return { title: event.detail ?? event.tool, detail: null }
}

const PRESENT_BY_KIND: Readonly<Record<AgentLiveEventKind, string>> = {
  read: "Reading the docs",
  search: "Searching the docs",
  edit: "Editing the docs",
  branch: "Working on a branch",
  preview: "Building a preview",
  publish: "Publishing",
  generation: "Running a generation",
  domain: "Changing a domain",
  approval: "Asking for approval",
}

function isAgentAction(event: AgentLiveEvent): boolean {
  return event.tool !== AGENT_APPROVAL_DECISION_TOOL
}

/** The newest event that the agent made. A person's approval decision is also in its feed. */
export function latestAgentAction(events: readonly AgentLiveEvent[]): AgentLiveEvent | undefined {
  return events.find(isAgentAction)
}

/** The newest approval that the agent asked for. */
export function latestApprovalRequest(events: readonly AgentLiveEvent[]): AgentLiveEvent | undefined {
  return events.find((event) => event.kind === "approval" && isAgentAction(event))
}

/** What an active agent is doing now, from its newest event. */
export function describeCurrentAction(event: AgentLiveEvent, titles: PageTitles): string {
  if (event.pageHref === null && event.pageTitle === null) return PRESENT_BY_KIND[event.kind]
  if (event.kind === "read") return `Reading ${pageName(event, titles)}`
  if (event.kind === "edit") return `Editing ${pageName(event, titles)}`
  return PRESENT_BY_KIND[event.kind]
}

/**
 * True when the editor can open the page of this edit. The page list holds
 * only the open branch, so a page on another branch counts as there.
 */
export function canOpenEdit(event: AgentLiveEvent, openBranch: string, titles: PageTitles): boolean {
  if (event.kind !== "edit" || event.branchId === null || event.pageHref === null) return false
  return event.branchId !== openBranch || titles.has(event.pageHref)
}

/** The pages that the events edited, once each, newest first, with their total size. */
export function changedPages(events: readonly AgentLiveEvent[], titles: PageTitles): ChangedPage[] {
  const pages = new Map<string, ChangedPage>()
  for (const event of events) {
    if (event.kind !== "edit" || event.pageHref === null) continue
    const known = pages.get(event.pageHref)
    pages.set(event.pageHref, {
      href: event.pageHref,
      title: known?.title ?? pageName(event, titles),
      occurredAt: known?.occurredAt ?? event.occurredAt,
      linesAdded: (known?.linesAdded ?? 0) + (event.linesAdded ?? 0),
      linesRemoved: (known?.linesRemoved ?? 0) + (event.linesRemoved ?? 0),
    })
  }
  return [...pages.values()]
}

/** Pure: one stream message applied to the cached snapshot. */
export function applyStreamMessage(
  current: AgentActivitySnapshot | null,
  message: AgentActivityStreamMessage,
): AgentActivitySnapshot | null {
  if (message.type === "snapshot") return message.snapshot
  if (current === null) return null
  if (message.type === "presence") return { ...current, agents: message.agents, serverTime: message.serverTime }
  if (message.event.seq <= current.latestSeq) return current
  return {
    ...current,
    events: [message.event, ...current.events].slice(0, MAX_KEPT_EVENTS),
    latestSeq: message.event.seq,
    serverTime: message.event.occurredAt > current.serverTime ? message.event.occurredAt : current.serverTime,
  }
}

function latestBranchOf(snapshot: AgentActivitySnapshot, grantRef: string): string | null {
  return snapshot.events.find((event) => event.grantRef === grantRef && event.branchId !== null)?.branchId ?? null
}

/** The agent to show for this branch. One that edits comes first, because it makes the page read-only. */
export function workingAgentOnBranch(snapshot: AgentActivitySnapshot, branch: string): AgentLiveAgent | null {
  const working = snapshot.agents.filter(
    (agent) => agent.presence !== "idle" && latestBranchOf(snapshot, agent.grantRef) === branch,
  )
  return working.find(({ presence }) => presence === "active") ?? working[0] ?? null
}

/** True while a person must not type here, so that a save cannot overwrite the agent. */
export function isAgentEditingBranch(snapshot: AgentActivitySnapshot, branch: string): boolean {
  return workingAgentOnBranch(snapshot, branch)?.presence === "active"
}

/** The agent's branch when it is not the branch that the person has open. */
export function agentBranchElsewhere(
  snapshot: AgentActivitySnapshot,
  agent: AgentLiveAgent,
  openBranch: string,
): string | null {
  if (agent.presence === "idle") return null
  const branch = latestBranchOf(snapshot, agent.grantRef)
  return branch !== null && branch !== openBranch ? branch : null
}

/** The page that an active agent touched last on this branch. */
export function livePageHref(snapshot: AgentActivitySnapshot, branch: string): string | null {
  const active = new Set(snapshot.agents.filter(({ presence }) => presence === "active").map(({ grantRef }) => grantRef))
  return (
    snapshot.events.find(
      (event) => active.has(event.grantRef) && event.branchId === branch && event.pageHref !== null,
    )?.pageHref ?? null
  )
}

/** Pure: a unified diff as lines to show. The file headers are left out. */
export function parseDiffLines(diff: string): DiffLine[] {
  const lines = diff.replace(/\n$/, "").split("\n")
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"))
  return (firstHunk === -1 ? [] : lines.slice(firstHunk)).map((line): DiffLine => {
    if (line.startsWith("@@")) return { kind: "hunk", text: line }
    if (line.startsWith("+")) return { kind: "add", text: line }
    if (line.startsWith("-")) return { kind: "remove", text: line }
    return { kind: "context", text: line }
  })
}

/** Uses the server's clock, so that a wrong browser clock cannot change the label. */
export function timeAgo(occurredAt: string, serverTime: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(serverTime) - Date.parse(occurredAt)) / 1000))
  if (seconds < 10) return "just now"
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  return `${Math.floor(minutes / 60)} h ago`
}
