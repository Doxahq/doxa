// @vitest-environment jsdom
import type { ReactNode } from "react"
import { act, cleanup, render, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { resolveSiteConfig } from "@doxahq/site-config"
import type { AgentActivitySnapshot, AgentLiveEvent } from "@doxahq/contracts/agent-live-activity"
import type { DocsContentPageDetailDto } from "@doxahq/contracts"
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"

const BRANCH = "55555555-5555-4555-8555-555555555555"
const BEFORE = "---\ntitle: Guide\n---\n\nFirst paragraph.\n\nSecond paragraph.\n"
const AFTER = "---\ntitle: Guide\n---\n\nFirst paragraph.\n\nThe agent wrote this paragraph.\n"
const CANVAS = { theme: resolveSiteConfig({}).theme, mode: "dark" as const, onModeChange: () => undefined }

/** One page on an agent's branch. A test can hold the answers to page reads. */
const server = vi.hoisted(() => ({ body: "", revision: 0, pageReads: 0, pageGate: Promise.resolve() }))

vi.mock("~/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/platform-api")>()),
  getProjectContent: async () => ({
    projectId: "p1",
    projectSlug: "example",
    siteId: "s1",
    working: { branchId: BRANCH, editedHrefs: ["/guide"], changeCount: 1, revision: server.revision },
    pages: [{ href: "/guide", title: "Guide", sourcePath: "source/guide/index.mdx", status: "edited", icon: null }],
    navigation: [{ slug: "docs", label: "Docs", isDefault: true, groups: [{ heading: null, groupIndex: null, hrefs: ["/guide"] }] }],
    siteConfig: { published: {}, working: null },
  }),
  getProjectContentPage: async (_projectId: string, href: string) => {
    server.pageReads += 1
    await server.pageGate
    return {
      href,
      title: "Guide",
      sourcePath: "source/guide/index.mdx",
      status: "edited",
      publishedContent: "",
      workingContent: server.body,
      revision: server.revision,
    } satisfies DocsContentPageDetailDto
  },
  getProjectContentMdxReport: async () => ({ pages: [] }),
}))

const { useProjectContent } = await import("~/lib/dashboard/use-project-content")
const { useAgentEditorSync } = await import("~/lib/dashboard/use-agent-editor-sync")
const { default: WriteEditor } = await import("~/components/dashboard/content/write-editor/write-editor")

function snapshotWith(events: AgentLiveEvent[], latestSeq: number): AgentActivitySnapshot {
  return { agents: [], events, latestSeq, serverTime: "2026-11-10T12:00:05.000Z" }
}

const AGENT_EDIT: AgentLiveEvent = {
  seq: 2,
  occurredAt: "2026-11-10T12:00:00.000Z",
  branchId: BRANCH,
  grantRef: "grant-1",
  clientName: "Claude Code",
  tool: "write_page",
  kind: "edit",
  pageHref: "/guide",
  pageTitle: null,
  detail: null,
  note: null,
  linesAdded: 1,
  linesRemoved: 1,
  branchRevision: 4,
  hasDiff: true,
}

function OpenPage({ snapshot }: { snapshot: AgentActivitySnapshot }) {
  const state = useProjectContent("p1", BRANCH, { requestedHref: "/guide", guardRevision: true })
  const sync = useAgentEditorSync({ projectId: "p1", branch: BRANCH, snapshot, state })
  if (state.page === null) return null
  return (
    <WriteEditor
      key={state.editorKey}
      value={state.text}
      onChange={state.setText}
      onSave={() => undefined}
      readOnly
      agentChanges={{ changes: sync.changes, now: snapshot.serverTime, reveal: sync.follow, reviewed: sync.reviewed, showMarks: true }}
      page={{ href: state.selectedHref, status: null }}
      showOutline={false}
      canvas={CANVAS}
    />
  )
}

async function openPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapped = (children: ReactNode) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const view = render(wrapped(<OpenPage snapshot={snapshotWith([], 1)} />))
  await waitFor(() => expect(document.querySelector(".doxa-write-content")?.textContent).toContain("Second paragraph."))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  return { receive: (event: AgentLiveEvent) => view.rerender(wrapped(<OpenPage snapshot={snapshotWith([event], event.seq)} />)) }
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined
})

beforeEach(() => {
  server.body = BEFORE
  server.revision = 3
  server.pageReads = 0
  server.pageGate = Promise.resolve()
})

afterEach(cleanup)

// REGRESSION: the page list answered first, so the revision check
// refreshed the page. That refresh cancelled the read that records the change.
// The new text arrived from the refresh, and the editor showed no mark.
test("marks an edit of the open page when the page list answers before the page", async () => {
  const { receive } = await openPage()
  const readsBefore = server.pageReads
  let answerPageReads = () => undefined as void
  server.pageGate = new Promise<void>((resolve) => {
    answerPageReads = resolve
  })
  server.body = AFTER
  server.revision = 4

  receive(AGENT_EDIT)
  await waitFor(() => expect(server.pageReads).toBe(readsBefore + 2))
  answerPageReads()

  await waitFor(() => {
    expect(document.querySelector(".doxa-agent-changed")?.textContent).toContain("The agent wrote this paragraph.")
  })
  expect(document.querySelectorAll(".doxa-agent-changed")).toHaveLength(1)
})

test("scrolls to the reviewed edit and marks only its blocks more strongly", async () => {
  const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView")
  const reviewed = { baseText: BEFORE, afterText: AFTER, changedAt: AGENT_EDIT.occurredAt }
  render(
    <WriteEditor
      value={AFTER}
      onChange={() => undefined}
      onSave={() => undefined}
      readOnly
      agentChanges={{ changes: [], now: "2026-11-10T12:00:05.000Z", reveal: false, reviewed, showMarks: true }}
      page={{ href: "/guide", status: null }}
      showOutline={false}
      canvas={CANVAS}
    />,
  )

  await waitFor(() => {
    expect(document.querySelector(".doxa-agent-reviewed")?.textContent).toContain("The agent wrote this paragraph.")
  })
  expect(document.querySelectorAll(".doxa-agent-reviewed")).toHaveLength(1)
  expect(scrollIntoView).toHaveBeenCalledTimes(1)
})

test("hides the marks when asked, still scrolls to the change, and shows the marks again", async () => {
  const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView")
  scrollIntoView.mockClear()
  const changes = [{ baseText: BEFORE, afterText: AFTER, changedAt: AGENT_EDIT.occurredAt }]
  const editorWith = (showMarks: boolean) => (
    <WriteEditor
      value={AFTER}
      onChange={() => undefined}
      onSave={() => undefined}
      readOnly
      agentChanges={{ changes, now: "2026-11-10T12:00:05.000Z", reveal: true, reviewed: null, showMarks }}
      page={{ href: "/guide", status: null }}
      showOutline={false}
      canvas={CANVAS}
    />
  )
  const view = render(editorWith(false))
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
  expect(document.querySelector(".doxa-agent-changed")).toBeNull()

  view.rerender(editorWith(true))
  await waitFor(() => expect(document.querySelector(".doxa-agent-changed")).not.toBeNull())
  expect(scrollIntoView).toHaveBeenCalledTimes(1)

  view.rerender(editorWith(false))
  await waitFor(() => expect(document.querySelector(".doxa-agent-changed")).toBeNull())
})
