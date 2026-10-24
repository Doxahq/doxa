// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { DocsContentOverviewDto, DocsPageMdxIssues } from "@doxahq/contracts"
import type { DashboardApprovalRequest } from "@doxahq/contracts/approval-requests"
import type { DocsBranchDiff, DocsBranchStatus, NamedDocsBranch } from "@doxahq/contracts/docs-branches"
import { FREE_PLAN_ENTITLEMENTS, resolveSiteConfig } from "@doxahq/site-config"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import {
  PublishMenu,
  type PublishMenuProps,
} from "~/components/dashboard/content/branches/publish-menu"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const baseVersionId = "20000000-0000-4000-8000-000000000001"
const published = {
  versionId: "20000000-0000-4000-8000-000000000002",
  versionNumber: 5,
  publicationId: "30000000-0000-4000-8000-000000000001",
  branchErased: true,
}

beforeEach(() => {
  // Radix reads these browser APIs. jsdom has no layout.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("publish menu", () => {
  test("a named branch erases itself by default", () => {
    renderMenu({ namedBranch: namedBranch() })
    const checkbox = screen.getByRole("checkbox", { name: "Erase this branch after publish" }) as HTMLInputElement
    expect(checkbox.checked).toBe(true)
  })

  test("main has no branch erase checkbox", () => {
    renderMenu()
    expect(screen.queryByRole("checkbox", { name: "Erase this branch after publish" })).toBeNull()
  })

  test("shows no version number before or after a publish", async () => {
    const stream = controlledEventStream()
    vi.stubGlobal("fetch", vi.fn(async () => stream.response))
    renderMenu()
    expect(screen.getByText("1 unpublished change on main")).toBeTruthy()
    expect(screen.queryByText(/version|\bv\d/i)).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Publish" }))
    stream.send({ type: "result", result: published })
    stream.close()

    await screen.findByRole("heading", { name: "Published to acme.doxa.page" })
    expect(screen.getByText("Your changes from main are live.")).toBeTruthy()
    expect(screen.queryByText(/version|\bv\d/i)).toBeNull()
  })

  test("publishes at once with the reviewed revision, then shows each stage until live", async () => {
    const stream = controlledEventStream()
    const fetchMock = vi.fn(async () => stream.response)
    vi.stubGlobal("fetch", fetchMock)
    const onBranchErased = vi.fn()
    renderMenu({ onBranchErased })

    fireEvent.click(screen.getByRole("button", { name: "Publish" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(new Headers(init.headers).get("accept")).toBe("text/event-stream")
    expect(JSON.parse(String(init.body))).toEqual({
      expectedBaseVersionId: baseVersionId,
      expectedRevision: 2,
      eraseBranch: true,
    })
    expect(await screen.findByRole("heading", { name: "Publishing to acme.doxa.page" })).toBeTruthy()
    expect(currentStep()).toBe("Preparing")

    stream.send({ type: "stage", stage: "preparing" })
    stream.send({ type: "stage", stage: "building" })
    await waitFor(() => expect(currentStep()).toBe("Building"))
    stream.send({ type: "stage", stage: "optimizing" })
    await waitFor(() => expect(currentStep()).toBe("Optimizing"))

    stream.send({ type: "result", result: published })
    stream.close()

    expect(await screen.findByRole("heading", { name: "Published to acme.doxa.page" })).toBeTruthy()
    expect(currentStep()).toBeNull()
    expect(screen.getByRole("link", { name: "Open site" }).getAttribute("href")).toBe("https://acme.doxa.page")
    await waitFor(() => expect(onBranchErased).toHaveBeenCalledOnce())
  })

  test("the menu does not close while a publish runs", async () => {
    const stream = controlledEventStream()
    vi.stubGlobal("fetch", vi.fn(async () => stream.response))
    const onOpenChange = vi.fn()
    renderMenu({ onOpenChange })

    fireEvent.click(screen.getByRole("button", { name: "Publish" }))
    await screen.findByRole("heading", { name: "Publishing to acme.doxa.page" })
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })

    expect(onOpenChange).not.toHaveBeenCalled()
    stream.send({ type: "result", result: published })
    stream.close()
    await screen.findByRole("heading", { name: "Published to acme.doxa.page" })
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  test("a failed stage shows the error and keeps the live site", async () => {
    const stream = controlledEventStream()
    vi.stubGlobal("fetch", vi.fn(async () => stream.response))
    renderMenu()

    fireEvent.click(screen.getByRole("button", { name: "Publish" }))
    stream.send({ type: "stage", stage: "preparing" })
    stream.send({
      type: "error",
      status: 409,
      body: {
        error: {
          message: "Main changed. Synchronize this branch first.",
          details: { code: "branch_behind" },
        },
      },
    })
    stream.close()

    expect(await screen.findByRole("heading", { name: "Publish failed" })).toBeTruthy()
    expect(screen.getByRole("alert").textContent).toBe("Main changed. Synchronize this branch first.")
    // Screen readers hear the state after each step label.
    expect(within(stepList("Publish progress")).getByText("Preparing").textContent).toBe("Preparing, failed")
    expect(within(stepList("Publish progress")).getByText("Building").textContent).toBe("Building, not started")
    expect(screen.getByRole("button", { name: "Synchronize first" })).toBeTruthy()
  })

  test("waits for the saved branch before it can publish", () => {
    renderMenu({ isOverviewRefreshing: true })
    expect(screen.getByRole("button", { name: "Publish" }).hasAttribute("disabled")).toBe(true)
  })

  test("lists the pages with MDX issues, blocks the publish, and opens a page", () => {
    const onOpenChange = vi.fn()
    const selectPage = vi.fn(async () => undefined)
    renderMenu({ mdxIssuePages: [mdxPage()], onOpenChange, selectPage })

    const list = screen.getByRole("region", { name: "Pages with MDX issues" })
    expect(within(list).getByRole("alert").textContent).toBe("Fix the MDX in 1 page before you publish.")
    const row = within(list).getByRole("button", { name: /Home/ })
    expect(row.textContent).toBe("HomeLine 7 +1")
    expect(screen.getByRole("button", { name: "Publish" }).hasAttribute("disabled")).toBe(true)

    fireEvent.click(row)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(selectPage).toHaveBeenCalledWith("/")
  })

  test("a publish that the server blocks for MDX issues offers no retry", async () => {
    const stream = controlledEventStream()
    vi.stubGlobal("fetch", vi.fn(async () => stream.response))
    renderMenu()

    fireEvent.click(screen.getByRole("button", { name: "Publish" }))
    stream.send({
      type: "error",
      status: 422,
      body: {
        error: {
          message: "Publish blocked: 1 page has MDX issues.",
          details: { code: "mdx_invalid", pages: [mdxPage()] },
        },
      },
    })
    stream.close()

    expect(await screen.findByRole("heading", { name: "Publish failed" })).toBeTruthy()
    expect(screen.getByRole("alert").textContent).toBe("Publish blocked: 1 page has MDX issues.")
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull()
  })

  test("the preview shows its two steps, then the URL", () => {
    const view = renderMenu({ view: "preview", preview: { isBuilding: true } })
    expect(currentStep()).toBe("Preparing preview")

    view.rerender({
      view: "preview",
      preview: { isReady: true, url: "https://acme-br-docs.doxa.page" },
    })
    expect(currentStep()).toBeNull()
    expect(screen.getByText("acme-br-docs.doxa.page")).toBeTruthy()
    expect(screen.getByRole("link", { name: "Open preview" }).getAttribute("href")).toBe("https://acme-br-docs.doxa.page")
  })
})

describe("preview back button", () => {
  test("returns to the agent's request when the preview opened from it", () => {
    const onViewChange = vi.fn()
    const branch = namedBranch()
    const view = renderMenu({ namedBranch: branch, view: "approval", approvalRequest: publishRequest(branch.id), onViewChange })
    fireEvent.click(screen.getByRole("button", { name: "Preview URL" }))
    expect(onViewChange).toHaveBeenLastCalledWith("preview")

    view.rerender({ view: "preview" })
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(onViewChange).toHaveBeenLastCalledWith("approval")
  })

  test("returns to the review when the preview opened from it", () => {
    const onViewChange = vi.fn()
    const view = renderMenu({ namedBranch: namedBranch(), onViewChange })
    fireEvent.click(screen.getByRole("button", { name: "Preview URL" }))
    view.rerender({ view: "preview" })
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(onViewChange).toHaveBeenLastCalledWith("review")
  })
})

describe("approval panel changed pages", () => {
  test("marks added and deleted pages and opens a page diff", async () => {
    const branch = namedBranch()
    const fetchMock = vi.fn(async () => Response.json(branchDiff()))
    vi.stubGlobal("fetch", fetchMock)
    const onOpenPageDiff = vi.fn()
    renderMenu({ namedBranch: branch, view: "approval", approvalRequest: publishRequest(branch.id), onOpenPageDiff })

    const list = await screen.findByRole("list", { name: "Changed pages" })
    const rows = within(list).getAllByRole("listitem")
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^Install.*\/install.*Edited.*Diff$/),
      expect.stringMatching(/^Legacy.*\/legacy.*Deleted.*Diff$/),
      expect.stringMatching(/^Rate limits.*\/rate-limits.*Added.*Diff$/),
    ])
    expect(screen.getByText("Also 1 structure or site settings change.")).toBeTruthy()
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toContain(`/projects/project-1/branches/${branch.id}/diff`)

    fireEvent.click(screen.getByRole("button", { name: "Show the diff of Legacy" }))
    expect(onOpenPageDiff).toHaveBeenCalledWith(expect.objectContaining({ href: "/legacy", change: "deleted" }))
  })

  test("lists the pages with MDX issues above the request", () => {
    const branch = namedBranch()
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(branchDiff())))
    renderMenu({ namedBranch: branch, view: "approval", approvalRequest: publishRequest(branch.id), mdxIssuePages: [mdxPage()] })

    expect(screen.getByRole("region", { name: "Pages with MDX issues" })).toBeTruthy()
  })

  test("says how many images the publish adds", async () => {
    const branch = namedBranch()
    const diff = {
      ...branchDiff(),
      assets: [
        { path: "/assets/flow.png", change: "added" as const, contentType: "image/png" as const, size: 10 },
        { path: "/assets/map.svg", change: "added" as const, contentType: "image/svg+xml" as const, size: 20 },
      ],
    }
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(diff)))
    renderMenu({ namedBranch: branch, view: "approval", approvalRequest: publishRequest(branch.id) })

    expect(await screen.findByText("Adds or replaces 2 images.")).toBeTruthy()
  })

  test("shows the error when the diff cannot load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "Branch not found." } }, { status: 404 })))
    const branch = namedBranch()
    renderMenu({ namedBranch: branch, view: "approval", approvalRequest: publishRequest(branch.id) })

    expect(await screen.findByText("Branch not found.")).toBeTruthy()
  })
})

describe("preview link copy", () => {
  afterEach(() => vi.useRealTimers())

  test("shows a check in the button for a moment, with no toast", async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    const { toast } = await import("sonner")
    renderMenu({ view: "preview", preview: { isReady: true, url: "https://acme-br-docs.doxa.page" } })
    vi.useFakeTimers()

    fireEvent.click(screen.getByRole("button", { name: "Copy preview link" }))
    await act(async () => {})

    expect(writeText).toHaveBeenCalledWith("https://acme-br-docs.doxa.page")
    expect(screen.getByRole("button", { name: "Preview link copied" })).toBeTruthy()
    expect(toast.success).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(1500))
    expect(screen.getByRole("button", { name: "Copy preview link" })).toBeTruthy()
  })
})

function mdxPage(): DocsPageMdxIssues {
  return {
    href: "/",
    sourcePath: "source/index.mdx",
    issues: [
      { line: 7, column: 1, message: "Unknown MDX component: Bogus" },
      { line: 9, column: 3, message: "Expected a closing tag" },
    ],
  }
}

/** The label of the step in progress, or null when no step runs. */
function currentStep(): string | null {
  const step = document.querySelector("[aria-current='step'] p")
  return step?.firstChild?.textContent ?? null
}

function stepList(name: string): HTMLElement {
  return screen.getByRole("list", { name })
}

/** A `text/event-stream` response whose events the test sends one by one. */
function controlledEventStream() {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
    },
  })
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    send(event: { type: string } & Record<string, unknown>) {
      controller?.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
    },
    close() {
      controller?.close()
    },
  }
}

interface MenuOptions {
  namedBranch?: NamedDocsBranch
  isOverviewRefreshing?: boolean
  view?: PublishMenuProps["view"]
  preview?: Partial<PublishMenuProps["preview"]>
  onOpenChange?: (open: boolean) => void
  onBranchErased?: () => void
  onViewChange?: (view: PublishMenuProps["view"]) => void
  approvalRequest?: DashboardApprovalRequest | null
  onOpenPageDiff?: PublishMenuProps["onOpenPageDiff"]
  mdxIssuePages?: DocsPageMdxIssues[]
  selectPage?: (href: string) => Promise<void>
}

function renderMenu(options: MenuOptions = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const view = render(<PublishMenu {...menuProps(options)} />, { wrapper })
  return {
    rerender: (next: MenuOptions) => view.rerender(<PublishMenu {...menuProps({ ...options, ...next })} />),
  }
}

function menuProps(options: MenuOptions): PublishMenuProps {
  const branch = options.namedBranch ?? null
  return {
    projectId: "project-1",
    state: {
      overview: overview(branch),
      pages: overview(branch).pages,
      hasChanges: true,
      isDirty: false,
      isSaving: false,
      isDiscarding: false,
      isOverviewRefreshing: options.isOverviewRefreshing ?? false,
      mdxIssuePages: options.mdxIssuePages ?? [],
      selectPage: options.selectPage ?? (async () => undefined),
    } as unknown as PublishMenuProps["state"],
    branch: branch?.id ?? "main",
    namedBranch: branch,
    branchName: branch?.name ?? "main",
    status: status(branch),
    changeCount: 1,
    host: "acme.doxa.page",
    docsUrl: "https://acme.doxa.page",
    preview: {
      url: null,
      error: null,
      isOutdated: false,
      isReady: false,
      canBuild: true,
      isBuilding: false,
      build: vi.fn(async () => undefined),
      reset: vi.fn(),
      ...options.preview,
    },
    open: true,
    view: options.view ?? "review",
    onOpenChange: options.onOpenChange ?? (() => undefined),
    onViewChange: options.onViewChange ?? (() => undefined),
    onSynchronize: () => undefined,
    onBranchErased: options.onBranchErased ?? (() => undefined),
    approvalRequest: options.approvalRequest ?? null,
    onOpenPageDiff: options.onOpenPageDiff ?? (() => undefined),
  }
}

function overview(branch: NamedDocsBranch | null): DocsContentOverviewDto {
  return {
    projectId: "project-1",
    projectSlug: "acme",
    siteId: "site-1",
    publishedVersion: {
      id: baseVersionId,
      versionNumber: 4,
      createdAt: "2026-09-24T10:00:00.000Z",
    },
    working: {
      branchId: branch?.id ?? null,
      baseVersionId,
      editedHrefs: ["/"],
      changeCount: 1,
      revision: 2,
      createdAt: "2026-09-24T10:00:00.000Z",
      updatedAt: "2026-09-24T11:00:00.000Z",
      isBaseCurrent: true,
    },
    entitlements: FREE_PLAN_ENTITLEMENTS,
    siteConfig: {
      published: resolveSiteConfig({ name: "Acme" }),
      working: null,
    },
    pages: [{
      href: "/",
      title: "Home",
      sourcePath: "source/index.mdx",
      status: "edited",
      icon: null,
    }],
    navigation: [],
  }
}

function status(branch: NamedDocsBranch | null): DocsBranchStatus {
  return {
    branch: branch
      ? { id: branch.id, kind: "named", name: branch.name, revision: branch.revision }
      : { id: null, kind: "hidden", name: null, revision: 2 },
    baseVersionId,
    main: {
      versionId: baseVersionId,
      versionNumber: 4,
      latestPublication: {
        kind: "editor",
        actorName: "Ada",
        createdAt: "2026-09-24T10:00:00.000Z",
      },
    },
    behind: false,
    publicationsSinceBase: 0,
    changeCount: 1,
    preview: null,
  }
}

function namedBranch(): NamedDocsBranch {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    kind: "named",
    name: "new-guides",
    purpose: "user",
    baseVersionId,
    createdFromBranchId: null,
    createdBy: { kind: "user" },
    revision: 2,
    changeCount: 1,
    createdAt: "2026-09-24T10:00:00.000Z",
    updatedAt: "2026-09-24T11:00:00.000Z",
  }
}

function branchDiff(): DocsBranchDiff {
  const page = (href: string, title: string, change: DocsBranchDiff["pages"][number]["change"]) => ({
    href,
    title,
    change,
    diff: "",
    lineCount: 0,
    truncated: false,
  })
  return {
    baseVersionId,
    mainVersionId: baseVersionId,
    behind: false,
    pages: [
      page("/install", "Install", "edited"),
      page("/legacy", "Legacy", "deleted"),
      page("/rate-limits", "Rate limits", "added"),
    ],
    structure: [{ path: "manifest.json", label: "Page list", change: "edited", diff: "", lineCount: 0, truncated: false }],
    siteSettings: null,
    assets: [],
  }
}

function publishRequest(branchId: string): DashboardApprovalRequest {
  return {
    id: "request-1",
    projectId: "project-1",
    actionKind: "docs.publish",
    actionAvailable: true,
    status: "pending",
    title: "Publish a branch",
    headline: "Publish 1 change",
    effects: [],
    summary: "Fix the install guide.",
    requestedBy: { userId: "owner-1", name: null, clientName: "Claude Code" },
    decidedBy: null,
    decisionNote: null,
    policySource: "action_default",
    reviewSurface: { kind: "publish_menu" },
    branchId,
    confirmationText: null,
    error: null,
    createdAt: "2026-10-04T12:00:00.000Z",
    expiresAt: "2026-10-11T12:00:00.000Z",
    decidedAt: null,
    completedAt: null,
    inputs: {},
    result: null,
    viewer: { canApprove: true, reason: null, canReject: true },
  }
}
