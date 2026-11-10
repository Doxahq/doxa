// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, renderHook } from "@testing-library/react"
import type { AgentActivitySnapshot, AgentLiveEvent } from "@doxahq/contracts/agent-live-activity"
import { afterEach, describe, expect, test, vi } from "vitest"

import { changesBranchList, useAgentBranchListRefresh } from "~/lib/dashboard/use-agent-branch-list-refresh"
import { docsBranchQueryKeys } from "~/lib/queries/docs-branches"

const LISTED = "55555555-5555-4555-8555-555555555555"
const NEW_BRANCH = "66666666-6666-4666-8666-666666666666"

function event(overrides: Partial<AgentLiveEvent>): AgentLiveEvent {
  return {
    seq: 2,
    occurredAt: "2026-11-10T12:00:00.000Z",
    branchId: LISTED,
    grantRef: "grant-1",
    clientName: "Claude Code",
    tool: "read_page",
    kind: "read",
    pageHref: null,
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

function snapshot(events: AgentLiveEvent[], latestSeq: number): AgentActivitySnapshot {
  return { agents: [], events, latestSeq, serverTime: "2026-11-10T12:00:05.000Z" }
}

function renderRefresh() {
  const client = new QueryClient()
  const invalidate = vi.spyOn(client, "invalidateQueries")
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const view = renderHook(
    ({ current }: { current: AgentActivitySnapshot | null }) =>
      useAgentBranchListRefresh({ projectId: "p1", snapshot: current, listedBranches: [{ id: LISTED }] }),
    { wrapper, initialProps: { current: snapshot([], 1) as AgentActivitySnapshot | null } },
  )
  return { invalidate, receive: (current: AgentActivitySnapshot) => view.rerender({ current }) }
}

afterEach(cleanup)

describe("changesBranchList", () => {
  const listed = new Set([LISTED])

  test.each(["edit", "branch", "publish"] as const)("a new %s event changes the list", (kind) => {
    expect(changesBranchList([event({ kind })], 1, listed)).toBe(true)
  })

  test("a read on a branch that the list holds does not", () => {
    expect(changesBranchList([event({})], 1, listed)).toBe(false)
  })

  test("any event on a branch that the list does not hold does", () => {
    expect(changesBranchList([event({ branchId: NEW_BRANCH })], 1, listed)).toBe(true)
  })

  test("an event that the page has seen does not", () => {
    expect(changesBranchList([event({ kind: "branch", seq: 1 })], 1, listed)).toBe(false)
  })
})

describe("useAgentBranchListRefresh", () => {
  const LIST_KEY = { queryKey: docsBranchQueryKeys.list("p1") }

  test("refreshes the list when an agent creates a branch", () => {
    const { invalidate, receive } = renderRefresh()
    receive(snapshot([event({ kind: "branch", tool: "create_branch", branchId: NEW_BRANCH })], 2))
    expect(invalidate.mock.calls).toEqual([[LIST_KEY]])
  })

  test("does not refresh for the first snapshot, a presence update, or a plain read", () => {
    const { invalidate, receive } = renderRefresh()
    receive(snapshot([], 1))
    receive(snapshot([event({})], 2))
    expect(invalidate).not.toHaveBeenCalled()
  })

  test("sees a branch from events that arrive together after a hidden tab", () => {
    const { invalidate, receive } = renderRefresh()
    receive(snapshot([event({ seq: 5 }), event({ seq: 4, kind: "branch", branchId: NEW_BRANCH })], 5))
    expect(invalidate.mock.calls).toEqual([[LIST_KEY]])
  })
})
