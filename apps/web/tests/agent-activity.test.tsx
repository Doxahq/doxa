// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  AGENT_APPROVAL_DECISION_TOOL,
  type AgentActivitySnapshot,
  type AgentLiveAgent,
  type AgentLiveEvent,
} from "@doxahq/contracts/agent-live-activity"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { AgentActivityButton } from "~/components/dashboard/content/agent-activity/agent-activity-button"
import { AgentActivityPanel, type AgentBranchActions } from "~/components/dashboard/content/agent-activity/agent-activity-panel"
import { AgentBranchBanner } from "~/components/dashboard/content/agent-activity/agent-branch-banner"
import type { AgentActivityConnection } from "~/lib/agent-activity-stream"
import { ApiRequestError } from "~/lib/api-errors"
import {
  agentBranchElsewhere,
  applyStreamMessage,
  canOpenEdit,
  changedPages,
  describeCurrentAction,
  describeEvent,
  isAgentEditingBranch,
  livePageHref,
  msUntilPresenceChanges,
  parseDiffLines,
  presenceLabel,
  snapshotAt,
  strongestPresence,
  timeAgo,
  workingAgentOnBranch,
} from "~/lib/dashboard/agent-activity-model"
import { revertUnifiedDiff } from "~/lib/dashboard/revert-unified-diff"
import { useAgentActivity } from "~/lib/dashboard/use-agent-activity"
import { editsAfter, newContentChanges, useAgentEditorSync } from "~/lib/dashboard/use-agent-editor-sync"
import { changeAgeLabel, changedBlockTimes } from "~/lib/editor/agent-change-highlight"
import { parseMdxDocumentCached } from "~/lib/editor/mdx-document-cache"
import { getAgentActivity } from "~/lib/agent-activity-api"

const apiFetch = vi.fn()
const getProjectContentPage = vi.fn()
vi.mock("~/lib/platform-api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  getProjectContent: () => Promise.resolve({ pages: [] }),
  getProjectContentPage: (...args: unknown[]) => getProjectContentPage(...args),
}))
vi.mock("~/lib/agent-activity-stream", () => ({
  followAgentActivity: (input: { onConnection: (connection: AgentActivityConnection) => void }) => {
    input.onConnection("live")
    return new Promise(() => undefined)
  },
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/test">{children}</a>,
}))

interface PanelOptions {
  connection?: AgentActivityConnection
  openBranch?: string
  onOpenBranch?: (branchId: string) => void
  onReviewEdit?: (edit: AgentLiveEvent | null) => void
  branchActions?: AgentBranchActions | null
}

const BRANCH = "55555555-5555-4555-8555-555555555555"
const OTHER_BRANCH = "66666666-6666-4666-8666-666666666666"
const SERVER_TIME = "2026-11-09T12:00:00.000Z"
const TITLES = new Map([["/quickstart", "Quickstart"]])

function event(overrides: Partial<AgentLiveEvent> = {}): AgentLiveEvent {
  return {
    seq: 1,
    occurredAt: "2026-11-09T11:59:30.000Z",
    branchId: null,
    grantRef: "grant-1",
    clientName: "Claude Code",
    tool: "write_page",
    kind: "edit",
    pageHref: "/quickstart",
    pageTitle: null,
    detail: null,
    note: null,
    linesAdded: null,
    linesRemoved: null,
    branchRevision: null,
    hasDiff: false,
    ...overrides,
  }
}

function agent(overrides: Partial<AgentLiveAgent> = {}): AgentLiveAgent {
  return {
    grantRef: "grant-1",
    clientName: "Claude Code",
    tokenName: "Acme docs",
    presence: "active",
    startedAt: "2026-11-09T11:57:00.000Z",
    lastEventAt: "2026-11-09T11:59:30.000Z",
    canRevoke: true,
    ...overrides,
  }
}

function snapshot(overrides: Partial<AgentActivitySnapshot> = {}): AgentActivitySnapshot {
  return { agents: [agent()], events: [event()], latestSeq: 1, serverTime: SERVER_TIME, ...overrides }
}

function showPanel(value: AgentActivitySnapshot, options: PanelOptions = {}) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <AgentActivityPanel
        projectId="project-1"
        snapshot={value}
        titles={TITLES}
        connection={options.connection ?? "live"}
        openBranch={options.openBranch ?? BRANCH}
        onOpenBranch={options.onOpenBranch ?? vi.fn()}
        onReviewEdit={options.onReviewEdit ?? vi.fn()}
        branchActions={options.branchActions ?? null}
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  )
}

function queryWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  apiFetch.mockReset()
  getProjectContentPage.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("agent activity model", () => {
  test("the strongest state wins for several agents", () => {
    expect(strongestPresence([agent({ presence: "idle" }), agent({ presence: "active" })])).toBe("active")
    expect(strongestPresence([agent({ presence: "active" }), agent({ presence: "waiting" })])).toBe("waiting")
    expect(strongestPresence([])).toBeNull()
  })

  test("describes events with the best known page name", () => {
    expect(describeEvent(event(), TITLES).title).toBe("Edited Quickstart")
    expect(describeEvent(event({ pageHref: "/other" }), TITLES).title).toBe("Edited /other")
    expect(describeEvent(event({ tool: "read_page", kind: "read", pageTitle: "Refunds" }), TITLES).title).toBe("Read Refunds")
    expect(describeEvent(event({ tool: "search_docs", kind: "search", pageHref: null, detail: "API key" }), TITLES)).toEqual({
      title: "Searched the docs",
      detail: "API key",
    })
    expect(describeEvent(event({ tool: "publish_branch", kind: "approval", pageHref: null, detail: "Publish branch" }), TITLES)).toEqual({
      title: "Asked for approval",
      detail: "Publish branch",
    })
  })

  test("names the current action in the present tense", () => {
    expect(describeCurrentAction(event(), TITLES)).toBe("Editing Quickstart")
    expect(describeCurrentAction(event({ kind: "search", tool: "search_docs", pageHref: null }), TITLES)).toBe("Searching the docs")
  })

  test("lists each changed page once, and skips reads and structure changes", () => {
    const pages = changedPages(
      [
        event({ seq: 4 }),
        event({ seq: 3, occurredAt: "2026-11-09T11:00:00.000Z" }),
        event({ seq: 2, kind: "read", tool: "read_page", pageHref: "/read" }),
        event({ seq: 1, pageHref: null, detail: "Site structure" }),
      ],
      TITLES,
    )
    expect(pages).toEqual([
      { href: "/quickstart", title: "Quickstart", occurredAt: "2026-11-09T11:59:30.000Z", linesAdded: 0, linesRemoved: 0 },
    ])
  })

  test("formats time from the server clock", () => {
    expect(timeAgo(SERVER_TIME, SERVER_TIME)).toBe("just now")
    expect(timeAgo("2026-11-09T11:59:30.000Z", SERVER_TIME)).toBe("30s ago")
    expect(timeAgo("2026-11-09T11:56:00.000Z", SERVER_TIME)).toBe("4 min ago")
    expect(timeAgo("2026-11-09T09:00:00.000Z", SERVER_TIME)).toBe("3 h ago")
  })
})

describe("live stream model", () => {
  test("adds a new event once, and keeps the newest first", () => {
    const start = snapshot()
    const next = applyStreamMessage(start, { type: "event", event: event({ seq: 2 }) })
    expect(next?.events.map(({ seq }) => seq)).toEqual([2, 1])
    expect(next?.latestSeq).toBe(2)
    expect(applyStreamMessage(next, { type: "event", event: event({ seq: 2 }) })).toBe(next)
  })

  test("replaces the agents on presence, and everything on a snapshot", () => {
    const start = snapshot()
    const later = "2026-11-09T12:00:15.000Z"
    expect(applyStreamMessage(start, { type: "presence", agents: [], serverTime: later })).toMatchObject({
      agents: [],
      serverTime: later,
      events: start.events,
    })
    const fresh = snapshot({ latestSeq: 9 })
    expect(applyStreamMessage(start, { type: "snapshot", snapshot: fresh })).toBe(fresh)
  })

  test("finds the agent on the open branch, and read-only applies only while it is active", () => {
    const working = snapshot({ events: [event({ branchId: BRANCH })] })
    expect(workingAgentOnBranch(working, BRANCH)?.grantRef).toBe("grant-1")
    expect(isAgentEditingBranch(working, BRANCH)).toBe(true)
    expect(isAgentEditingBranch(working, OTHER_BRANCH)).toBe(false)
    const waiting = { ...working, agents: [agent({ presence: "waiting" as const })] }
    expect(workingAgentOnBranch(waiting, BRANCH)?.presence).toBe("waiting")
    expect(isAgentEditingBranch(waiting, BRANCH)).toBe(false)
    const idle = { ...working, agents: [agent({ presence: "idle" as const })] }
    expect(workingAgentOnBranch(idle, BRANCH)).toBeNull()
  })

  test("never treats main as an agent branch", () => {
    expect(isAgentEditingBranch(snapshot({ events: [event({ branchId: null })] }), "main")).toBe(false)
  })

  test("points to the agent branch from another branch", () => {
    const working = snapshot({ events: [event({ branchId: BRANCH })] })
    expect(agentBranchElsewhere(working, agent(), "main")).toBe(BRANCH)
    expect(agentBranchElsewhere(working, agent(), BRANCH)).toBeNull()
  })

  test("marks the page of an active agent only", () => {
    const working = snapshot({ events: [event({ branchId: BRANCH, pageHref: "/live" })] })
    expect(livePageHref(working, BRANCH)).toBe("/live")
    expect(livePageHref({ ...working, agents: [agent({ presence: "idle" })] }, BRANCH)).toBeNull()
  })

  test("reads diff lines without the file headers", () => {
    expect(parseDiffLines("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same\n")).toEqual([
      { kind: "hunk", text: "@@ -1 +1 @@" },
      { kind: "remove", text: "-old" },
      { kind: "add", text: "+new" },
      { kind: "context", text: " same" },
    ])
  })

  test("adds up the size of each changed page", () => {
    const pages = changedPages([event({ seq: 2, linesAdded: 3, linesRemoved: 1 }), event({ seq: 1, linesAdded: 2, linesRemoved: 0 })], TITLES)
    expect(pages[0]).toMatchObject({ linesAdded: 5, linesRemoved: 1 })
  })

  test("takes only new page edits on this branch", () => {
    const value = snapshot({
      events: [
        event({ seq: 5, branchId: BRANCH }),
        event({ seq: 4, branchId: OTHER_BRANCH }),
        event({ seq: 3, branchId: BRANCH, kind: "read", tool: "read_page" }),
        event({ seq: 2, branchId: BRANCH }),
      ],
    })
    expect(newContentChanges(value, 2, BRANCH).map(({ seq }) => seq)).toEqual([5])
  })

  test("counts a sync as a change of the branch content", () => {
    const value = snapshot({ events: [event({ seq: 3, branchId: BRANCH, kind: "branch", tool: "sync_branch", pageHref: null })] })
    expect(newContentChanges(value, 2, BRANCH).map(({ seq }) => seq)).toEqual([3])
  })

  test("a waiting agent does not hide an active agent on the same branch", () => {
    const waiting = agent({ grantRef: "grant-1", presence: "waiting" })
    const active = agent({ grantRef: "grant-2", presence: "active" })
    const working = snapshot({
      agents: [waiting, active],
      events: [event({ seq: 2, grantRef: "grant-1", branchId: BRANCH }), event({ seq: 1, grantRef: "grant-2", branchId: BRANCH })],
    })
    expect(workingAgentOnBranch(working, BRANCH)?.grantRef).toBe("grant-2")
    expect(isAgentEditingBranch(working, BRANCH)).toBe(true)
  })

  test("marks only the blocks that the edit changed", () => {
    const doc = parseMdxDocumentCached("Same\n\nNew\n\nAdded\n").content
    const times = changedBlockTimes(doc, [
      { baseText: "Same\n\nOld\n", afterText: "Same\n\nNew\n\nAdded\n", changedAt: SERVER_TIME },
    ])
    expect([...times]).toEqual([
      [1, SERVER_TIME],
      [2, SERVER_TIME],
    ])
  })

  test("keeps the marks of earlier edits, each with its own time", () => {
    const first = "2026-11-09T11:59:00.000Z"
    const doc = parseMdxDocumentCached("Same\n\nFirst\n\nSecond\n").content
    const times = changedBlockTimes(doc, [
      { baseText: "Same\n", afterText: "Same\n\nFirst\n", changedAt: first },
      { baseText: "Same\n\nFirst\n", afterText: "Same\n\nFirst\n\nSecond\n", changedAt: SERVER_TIME },
    ])
    expect([...times]).toEqual([
      [1, first],
      [2, SERVER_TIME],
    ])
  })

  test("does not mark text that a person wrote between two agent edits", () => {
    const doc = parseMdxDocumentCached("Same\n\nFirst\n\nMine\n\nSecond\n").content
    const times = changedBlockTimes(doc, [
      { baseText: "Same\n", afterText: "Same\n\nFirst\n", changedAt: "2026-11-09T11:59:00.000Z" },
      { baseText: "Same\n\nFirst\n\nMine\n", afterText: "Same\n\nFirst\n\nMine\n\nSecond\n", changedAt: SERVER_TIME },
    ])
    expect([...times.keys()]).toEqual([1, 3])
  })

  test("marks nothing without a change", () => {
    expect(changedBlockTimes(parseMdxDocumentCached("Same\n").content, []).size).toBe(0)
  })

  test("labels a change with its age", () => {
    expect(changeAgeLabel(SERVER_TIME, SERVER_TIME)).toBe("Just now")
    expect(changeAgeLabel("2026-11-09T11:59:48.000Z", SERVER_TIME)).toBe("Changed 12s ago")
  })
})

describe("presence over time", () => {
  const secondsAgo = (seconds: number) => new Date(Date.parse(SERVER_TIME) - seconds * 1000).toISOString()
  const at = (agents: AgentLiveAgent[]) => snapshotAt(snapshot({ agents }), Date.parse(SERVER_TIME)).agents

  test("calls the working state Active", () => {
    expect(presenceLabel(agent(), SERVER_TIME)).toBe("Active")
  })

  test("an agent stops being active 60 seconds after its last event", () => {
    expect(at([agent({ lastEventAt: secondsAgo(59) })])[0]?.presence).toBe("active")
    expect(at([agent({ lastEventAt: secondsAgo(60) })])[0]?.presence).toBe("idle")
  })

  test("a pending approval stays waiting, and an old agent leaves the list", () => {
    expect(at([agent({ presence: "waiting", lastEventAt: secondsAgo(3600) })])[0]?.presence).toBe("waiting")
    expect(at([agent({ presence: "idle", lastEventAt: secondsAgo(1801) })])).toEqual([])
  })

  test("moves the clock of the snapshot", () => {
    const later = Date.parse(SERVER_TIME) + 5000
    expect(snapshotAt(snapshot(), later).serverTime).toBe(new Date(later).toISOString())
  })

  test("finds the next moment that age changes a presence", () => {
    const now = Date.parse(SERVER_TIME)
    expect(msUntilPresenceChanges([agent({ lastEventAt: secondsAgo(50) })], now)).toBe(10_000)
    expect(msUntilPresenceChanges([agent({ presence: "idle", lastEventAt: secondsAgo(1790) })], now)).toBe(10_001)
    expect(msUntilPresenceChanges([agent({ presence: "waiting" })], now)).toBeNull()
    expect(msUntilPresenceChanges([], now)).toBeNull()
  })

  test("the status ends on time when the server sends nothing more", async () => {
    vi.useFakeTimers({ now: Date.parse(SERVER_TIME), toFake: ["Date", "setTimeout", "clearTimeout"] })
    apiFetch.mockResolvedValue(snapshot({ agents: [agent({ lastEventAt: secondsAgo(50) })] }))
    const { result } = renderHook(() => useAgentActivity("project-1"), { wrapper: queryWrapper() })
    await act(() => vi.advanceTimersByTimeAsync(10))
    expect(result.current.presence).toBe("active")
    expect(result.current.connection).toBe("live")
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(result.current.presence).toBe("idle")
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })
})

describe("revertUnifiedDiff", () => {
  const DIFF = "--- a/x\n+++ b/x\n@@ -1,3 +1,4 @@\n Intro\n \n-Old\n+New\n+More\n"

  test("gives back the text before the edit", () => {
    expect(revertUnifiedDiff("Intro\n\nNew\nMore\n", DIFF)).toBe("Intro\n\nOld\n")
  })

  test("keeps the lines around each hunk", () => {
    const diff = "@@ -2,1 +2,1 @@\n-b\n+B\n@@ -4,1 +4,1 @@\n-d\n+D\n"
    expect(revertUnifiedDiff("a\nB\nc\nD\ne\n", diff)).toBe("a\nb\nc\nd\ne\n")
  })

  test("reads a new file and a removed last section", () => {
    expect(revertUnifiedDiff("One\nTwo\n", "--- /dev/null\n+++ b/x\n@@ -0,0 +1,2 @@\n+One\n+Two\n")).toBe("")
    expect(revertUnifiedDiff("a\n", "@@ -2,1 +1,0 @@\n-gone\n")).toBe("a\ngone\n")
  })

  test("ignores the marker of a missing final newline", () => {
    expect(revertUnifiedDiff("New", "@@ -1 +1 @@\n-Old\n\\ No newline at end of file\n+New\n\\ No newline at end of file\n")).toBe("Old")
  })

  test("keeps the text past a cut, also when the cut splits a line", () => {
    const cut = "@@ -1,3 +1,3 @@\n-a\n+A\n-b\n+Bbb".slice(0, -2)
    expect(revertUnifiedDiff("A\nBbb\nc\n", cut)).toBe("a\nb\nBbb\nc\n")
  })

  test("refuses a diff that does not fit the text", () => {
    expect(revertUnifiedDiff("Changed again\nmore\n", "@@ -1,2 +1,2 @@\n-Old\n+New\n more\n")).toBeNull()
    expect(revertUnifiedDiff("text\n", "no hunks here\n")).toBeNull()
  })
})

describe("useAgentEditorSync", () => {
  const BEFORE = "Intro\n\nOld\n"
  const AFTER = "Intro\n\nNew\n"
  const DIFF = "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n Intro\n \n-Old\n+New\n"
  const EDITED_AT = "2026-11-09T11:59:50.000Z"

  function editorState(overrides: Partial<Parameters<typeof useAgentEditorSync>[0]["state"]> = {}) {
    return {
      selectedHref: "/open",
      text: "Open page\n",
      isDirty: false,
      reloadOpenPage: vi.fn(() => Promise.resolve<string | null>(AFTER)),
      selectPage: vi.fn(),
      ...overrides,
    }
  }

  function renderSync(state: ReturnType<typeof editorState>) {
    const props = { projectId: "project-1", branch: BRANCH, snapshot: snapshot({ events: [], latestSeq: 1 }), state }
    const view = renderHook((current: typeof props) => useAgentEditorSync(current), {
      wrapper: queryWrapper(),
      initialProps: props,
    })
    return {
      ...view,
      receive: (edit: AgentLiveEvent) => view.rerender({ ...props, snapshot: snapshot({ events: [edit], latestSeq: edit.seq }) }),
      moveTo: (edit: AgentLiveEvent, href: string) =>
        view.rerender({
          ...props,
          snapshot: snapshot({ events: [edit], latestSeq: edit.seq }),
          state: { ...state, selectedHref: href },
        }),
    }
  }

  const editOf = (href: string, hasDiff: boolean) =>
    event({ seq: 2, branchId: BRANCH, pageHref: href, hasDiff, occurredAt: EDITED_AT })

  test("opens a followed page with the text from before the edit", async () => {
    getProjectContentPage.mockResolvedValue({ workingContent: AFTER, publishedContent: BEFORE })
    apiFetch.mockResolvedValue({ diff: DIFF })
    const state = editorState()
    const view = renderSync(state)
    const edit = editOf("/other", true)
    view.receive(edit)
    await waitFor(() => expect(state.selectPage).toHaveBeenCalledWith("/other"))
    expect(apiFetch).toHaveBeenCalledWith("/projects/project-1/agent-activity/2/diff")
    view.moveTo(edit, "/other")
    expect(view.result.current.changes).toEqual([{ baseText: BEFORE, afterText: AFTER, changedAt: EDITED_AT }])
    expect(view.result.current.follow).toBe(true)
  })

  test("still opens a followed page that has no stored diff, without marks", async () => {
    getProjectContentPage.mockResolvedValue({ workingContent: AFTER, publishedContent: BEFORE })
    const state = editorState()
    const view = renderSync(state)
    const edit = editOf("/other", false)
    view.receive(edit)
    await waitFor(() => expect(state.selectPage).toHaveBeenCalledWith("/other"))
    expect(apiFetch).not.toHaveBeenCalled()
    view.moveTo(edit, "/other")
    expect(view.result.current.changes).toEqual([])
  })

  describe("reviewing an edit from the activity list", () => {
    const LATER_DIFF = "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n-Intro\n+Changed\n \n New\n"
    const reviewedEdit = event({ seq: 2, branchId: BRANCH, pageHref: "/open", hasDiff: true, occurredAt: EDITED_AT })
    const laterEdit = event({ seq: 3, branchId: BRANCH, pageHref: "/open", hasDiff: true })

    test("opens the page, stops following, and finds the edit under later edits", async () => {
      getProjectContentPage.mockResolvedValue({ workingContent: "Changed\n\nNew\n", publishedContent: BEFORE })
      apiFetch.mockImplementation((path: string) => Promise.resolve({ diff: path.includes("/3/") ? LATER_DIFF : DIFF }))
      const state = editorState()
      const view = renderSync(state)
      view.rerender({ projectId: "project-1", branch: BRANCH, snapshot: snapshot({ events: [laterEdit, reviewedEdit], latestSeq: 1 }), state })

      act(() => view.result.current.reviewEdit(reviewedEdit))

      expect(state.selectPage).toHaveBeenCalledWith("/open")
      expect(view.result.current.follow).toBe(false)
      await waitFor(() =>
        expect(view.result.current.reviewed).toEqual({ baseText: BEFORE, afterText: AFTER, changedAt: EDITED_AT }),
      )
    })

    test("waits for the branch of the edit, and keeps following off after the switch", () => {
      getProjectContentPage.mockResolvedValue({ workingContent: AFTER, publishedContent: BEFORE })
      apiFetch.mockResolvedValue({ diff: DIFF })
      const state = editorState()
      const view = renderSync(state)

      act(() => view.result.current.reviewEdit({ ...reviewedEdit, branchId: OTHER_BRANCH, pageHref: "/other" }))
      expect(state.selectPage).not.toHaveBeenCalled()

      view.rerender({ projectId: "project-1", branch: OTHER_BRANCH, snapshot: snapshot({ events: [], latestSeq: 1 }), state })
      expect(state.selectPage).toHaveBeenCalledWith("/other")
      expect(view.result.current.follow).toBe(false)
    })

    test("ends when the review is cleared", async () => {
      getProjectContentPage.mockResolvedValue({ workingContent: AFTER, publishedContent: BEFORE })
      apiFetch.mockResolvedValue({ diff: DIFF })
      const view = renderSync(editorState())
      act(() => view.result.current.reviewEdit(reviewedEdit))
      await waitFor(() => expect(view.result.current.reviewed).not.toBeNull())

      act(() => view.result.current.reviewEdit(null))
      expect(view.result.current.reviewed).toBeNull()
    })

    test("editsAfter keeps only later edits of the same page and branch", () => {
      const samePageRead = event({ seq: 4, kind: "read", branchId: BRANCH, pageHref: "/open" })
      const otherPage = event({ seq: 5, branchId: BRANCH, pageHref: "/other" })
      const otherBranch = event({ seq: 6, branchId: OTHER_BRANCH, pageHref: "/open" })
      const earlier = event({ seq: 1, branchId: BRANCH, pageHref: "/open" })
      expect(editsAfter([otherBranch, otherPage, samePageRead, laterEdit, reviewedEdit, earlier], reviewedEdit)).toEqual([laterEdit])
    })
  })

  test("reloads the open page and keeps its text from before the edit", async () => {
    const state = editorState()
    const view = renderSync(state)
    view.receive(editOf("/open", true))
    expect(state.reloadOpenPage).toHaveBeenCalledTimes(1)
    expect(state.selectPage).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(view.result.current.changes).toEqual([{ baseText: "Open page\n", afterText: AFTER, changedAt: EDITED_AT }]),
    )
  })

  test("records nothing when the open page cannot load again", async () => {
    const state = editorState({ reloadOpenPage: vi.fn(() => Promise.resolve(null)) })
    const view = renderSync(state)
    view.receive(editOf("/open", true))
    await act(() => Promise.resolve())
    expect(view.result.current.changes).toEqual([])
  })

  test("refreshes the content after a sync, and stays on the open page", async () => {
    const state = editorState()
    const view = renderSync(state)
    view.receive(event({ seq: 2, branchId: BRANCH, kind: "branch", tool: "sync_branch", pageHref: null }))
    await act(() => Promise.resolve())
    expect(state.selectPage).not.toHaveBeenCalled()
    expect(view.result.current.changes).toEqual([])
  })

  test("does not move a person who has unsaved text", async () => {
    getProjectContentPage.mockResolvedValue({ workingContent: AFTER, publishedContent: BEFORE })
    const state = editorState({ isDirty: true })
    renderSync(state).receive(editOf("/other", true))
    await act(() => Promise.resolve())
    expect(getProjectContentPage).not.toHaveBeenCalled()
    expect(state.selectPage).not.toHaveBeenCalled()
    expect(state.reloadOpenPage).not.toHaveBeenCalled()
  })

  test("does not open a page that cannot load, for example a deleted page", async () => {
    getProjectContentPage.mockRejectedValue(new ApiRequestError("Not found", 404, null))
    const state = editorState()
    renderSync(state).receive(editOf("/gone", true))
    await waitFor(() => expect(getProjectContentPage).toHaveBeenCalled())
    await act(() => Promise.resolve())
    expect(state.selectPage).not.toHaveBeenCalled()
  })
})

describe("getAgentActivity", () => {
  test("treats 404 as a feature that is off", async () => {
    apiFetch.mockRejectedValue(new ApiRequestError("Not found", 404, null))
    await expect(getAgentActivity("project-1")).resolves.toBeNull()
  })

  test("lets other errors through", async () => {
    apiFetch.mockRejectedValue(new ApiRequestError("Down", 500, null))
    await expect(getAgentActivity("project-1")).rejects.toThrow("Down")
  })
})

describe("AgentActivityButton", () => {
  test("says the state in its name and shows no dot without an agent", () => {
    const { container } = render(<AgentActivityButton presence={null} agentCount={0} open={false} onToggle={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Agent activity" })).toBeTruthy()
    expect(container.querySelector(".rounded-full")).toBeNull()
  })

  test("names a waiting agent", () => {
    render(<AgentActivityButton presence="waiting" agentCount={1} open onToggle={vi.fn()} />)
    const button = screen.getByRole("button", { name: "Agent activity: an agent is waiting for you" })
    expect(button.getAttribute("aria-expanded")).toBe("true")
  })
})

describe("AgentActivityPanel", () => {
  test("shows the empty state before any activity", () => {
    showPanel(snapshot({ agents: [], events: [], latestSeq: 0 }))
    expect(screen.getByText("No agent activity")).toBeTruthy()
    expect(screen.getByText("Connect your agent")).toBeTruthy()
  })

  test("shows the agent, its action, and its activity", () => {
    showPanel(snapshot())
    expect(screen.getByText("Claude Code")).toBeTruthy()
    expect(screen.getByText("unverified")).toBeTruthy()
    expect(screen.getByText("Active")).toBeTruthy()
    expect(screen.getByText("Editing Quickstart")).toBeTruthy()
    expect(screen.getByText("Edited Quickstart")).toBeTruthy()
  })

  test("names the pending request of a waiting agent, also after a newer event", () => {
    showPanel(
      snapshot({
        agents: [agent({ presence: "waiting" })],
        events: [
          event({ seq: 2, kind: "read", tool: "get_docs_structure", pageHref: null, detail: "Page list" }),
          event({ seq: 1, kind: "approval", tool: "publish_branch", pageHref: null, detail: "Publish branch" }),
        ],
      }),
    )
    expect(screen.getByText("Needs your approval")).toBeTruthy()
    expect(screen.getAllByText("Publish branch").length).toBeGreaterThan(0)
  })

  test("does not call a person's decision the agent's current action", () => {
    showPanel(
      snapshot({
        events: [
          event({ seq: 3, kind: "approval", tool: AGENT_APPROVAL_DECISION_TOOL, pageHref: null, detail: "Approved" }),
          event({ seq: 2 }),
        ],
      }),
    )
    expect(screen.getByText("Now")).toBeTruthy()
    expect(screen.getByText("Editing Quickstart")).toBeTruthy()
    expect(screen.queryByText("Asking for approval")).toBeNull()
  })

  test("shows agent text as plain text", () => {
    showPanel(snapshot({ agents: [agent({ clientName: "<img src=x onerror=alert(1)>" })] }))
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy()
    expect(document.querySelector("img")).toBeNull()
  })

  test("offers revoke only to the owner, and asks first", async () => {
    apiFetch.mockResolvedValue({ revoked: true })
    const user = userEvent.setup()
    showPanel(snapshot())
    await user.click(screen.getByRole("button", { name: "Revoke agent access" }))
    expect(apiFetch).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Revoke" }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith("/projects/project-1/agent-activity/agents/grant-1", { method: "DELETE" }),
    )
  })

  test("hides revoke from another member", () => {
    showPanel(snapshot({ agents: [agent({ canRevoke: false })] }))
    expect(screen.queryByRole("button", { name: "Revoke agent access" })).toBeNull()
  })

  test("switches between two agents", async () => {
    const user = userEvent.setup()
    showPanel(
      snapshot({
        agents: [agent(), agent({ grantRef: "grant-2", clientName: "Cursor", tokenName: null })],
        events: [
          event({ seq: 2, grantRef: "grant-2", tool: "read_page", kind: "read", pageHref: "/webhooks", pageTitle: "Webhooks" }),
          event(),
        ],
      }),
    )
    expect(screen.getByText("Edited Quickstart")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Cursor" }))
    expect(screen.getByText("Read Webhooks")).toBeTruthy()
    expect(screen.queryByText("Edited Quickstart")).toBeNull()
  })

  test("sends a waiting agent's owner to the request", () => {
    showPanel(snapshot({ agents: [agent({ presence: "waiting" })], events: [event({ kind: "approval", tool: "publish_branch", pageHref: null, detail: "Publish branch" })] }))
    expect(screen.getByText("Needs your approval")).toBeTruthy()
    expect(screen.getByText("Review the request")).toBeTruthy()
  })

  test("shows the agent note and the size of an edit", () => {
    showPanel(snapshot({ events: [event({ note: "Fix the steps", linesAdded: 12, linesRemoved: 5 })] }))
    expect(screen.getByText("Fix the steps")).toBeTruthy()
    expect(screen.getByText("+12")).toBeTruthy()
  })

  test("loads the diff of an edit only when a person expands it", async () => {
    apiFetch.mockResolvedValue({ diff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+<b>new</b>\n" })
    const user = userEvent.setup()
    showPanel(snapshot({ events: [event({ seq: 7, hasDiff: true })] }))
    expect(apiFetch).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: /Edited Quickstart/ }))
    expect(await screen.findByText("+<b>new</b>")).toBeTruthy()
    expect(document.querySelector("b")).toBeNull()
    expect(apiFetch).toHaveBeenCalledWith("/projects/project-1/agent-activity/7/diff")
  })

  test("opens the MCP dialog in place from the empty state", async () => {
    const user = userEvent.setup()
    showPanel(snapshot({ agents: [], events: [], latestSeq: 0 }))
    expect(screen.queryByRole("dialog")).toBeNull()
    await user.click(screen.getByRole("button", { name: "Connect your agent" }))
    expect(await screen.findByRole("dialog", { name: "Connect an agent with MCP" })).toBeTruthy()
  })

  test("a click on an edit reviews it, shows its diff, and a second click ends the review", async () => {
    apiFetch.mockResolvedValue({ diff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n" })
    const user = userEvent.setup()
    const onReviewEdit = vi.fn()
    const edit = event({ seq: 7, branchId: BRANCH, hasDiff: true })
    showPanel(snapshot({ events: [edit] }), { onReviewEdit })
    const row = screen.getByRole("button", { name: /Edited Quickstart/ })

    await user.click(row)
    expect(onReviewEdit).toHaveBeenLastCalledWith(edit)
    expect(await screen.findByText("+new")).toBeTruthy()

    await user.click(row)
    expect(onReviewEdit).toHaveBeenLastCalledWith(null)
    expect(screen.queryByText("+new")).toBeNull()
  })

  test("an edit without a diff still opens its page", async () => {
    const user = userEvent.setup()
    const onReviewEdit = vi.fn()
    const edit = event({ seq: 7, branchId: BRANCH })
    showPanel(snapshot({ events: [edit] }), { onReviewEdit })
    await user.click(screen.getByRole("button", { name: /Edited Quickstart/ }))
    expect(onReviewEdit).toHaveBeenCalledWith(edit)
  })

  test("a diff of a page that is gone shows, and opens no page", async () => {
    apiFetch.mockResolvedValue({ diff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n" })
    const user = userEvent.setup()
    const onReviewEdit = vi.fn()
    showPanel(snapshot({ events: [event({ seq: 7, branchId: BRANCH, pageHref: "/gone", hasDiff: true })] }), { onReviewEdit })
    await user.click(screen.getByRole("button", { name: /Edited/ }))
    expect(onReviewEdit).toHaveBeenCalledWith(null)
    expect(await screen.findByText("+new")).toBeTruthy()
  })

  test("canOpenEdit needs an edit with a page and a branch", () => {
    expect(canOpenEdit(event({ branchId: BRANCH }), BRANCH, TITLES)).toBe(true)
    expect(canOpenEdit(event({ branchId: OTHER_BRANCH, pageHref: "/elsewhere" }), BRANCH, TITLES)).toBe(true)
    expect(canOpenEdit(event({ branchId: BRANCH, kind: "read" }), BRANCH, TITLES)).toBe(false)
    expect(canOpenEdit(event({ branchId: null }), BRANCH, TITLES)).toBe(false)
    expect(canOpenEdit(event({ branchId: BRANCH, pageHref: null }), BRANCH, TITLES)).toBe(false)
  })

  test("has no button on a row without a diff", () => {
    showPanel(snapshot())
    expect(screen.queryByRole("button", { name: /Edited Quickstart/ })).toBeNull()
  })

  test("warns when live updates stopped", () => {
    showPanel(snapshot(), { connection: "reconnecting" })
    expect(screen.getByText("Live updates stopped. Reconnecting. The agent can still make changes.")).toBeTruthy()
  })

  test("leads a person on another branch to the agent", async () => {
    const onOpenBranch = vi.fn()
    const user = userEvent.setup()
    showPanel(snapshot({ events: [event({ branchId: BRANCH })] }), { openBranch: "main", onOpenBranch })
    await user.click(screen.getByRole("button", { name: "Open the agent branch" }))
    expect(onOpenBranch).toHaveBeenCalledWith(BRANCH)
  })

  test("offers preview and review on the agent branch", async () => {
    const onReviewChanges = vi.fn()
    const user = userEvent.setup()
    showPanel(snapshot(), { branchActions: { canBuildPreview: false, onBuildPreview: vi.fn(), onReviewChanges } })
    expect((screen.getByRole("button", { name: "Build preview" }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole("button", { name: "Review changes" }))
    expect(onReviewChanges).toHaveBeenCalled()
  })
})

describe("AgentBranchBanner", () => {
  test("says that the page is read-only, and toggles follow", async () => {
    const onFollowChange = vi.fn()
    const user = userEvent.setup()
    render(<AgentBranchBanner agent={agent()} follow onFollowChange={onFollowChange} />)
    expect(screen.getByText(/read-only until the agent stops/)).toBeTruthy()
    await user.click(screen.getByRole("switch", { name: "Follow the agent" }))
    expect(onFollowChange).toHaveBeenCalledWith(false)
  })

  test("has no follow switch while the agent waits for approval", () => {
    render(<AgentBranchBanner agent={agent({ presence: "waiting" })} follow onFollowChange={vi.fn()} />)
    expect(screen.queryByRole("switch")).toBeNull()
  })
})
