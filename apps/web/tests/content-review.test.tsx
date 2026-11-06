// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import type { DocsContentPageDto } from "@doxahq/contracts"
import type {
  GenerationReview,
  GenerationReviewPage,
  GenerationReviewPageSources,
} from "@doxahq/contracts/generation-reviews"
import { afterEach, describe, expect, test, vi } from "vitest"

import { ContentPageRow } from "~/components/dashboard/content/content-page-row"
import { ReviewChangeList } from "~/components/dashboard/content/review/review-change-list"
import type { ReviewDecisionControl } from "~/components/dashboard/content/review/review-decision-bar"
import { ReviewDiffPane } from "~/components/dashboard/content/review/review-diff-pane"
import { ReviewFinishDialog } from "~/components/dashboard/content/review/review-finish-dialog"
import { ReviewEditsDialog } from "~/components/dashboard/content/review/review-edits-dialog"
import { ReviewAbsentPageNotice } from "~/components/dashboard/content/review/review-page-notice"
import { ReviewChangeCountDots } from "~/components/dashboard/content/review/review-marks"
import {
  adjacentReviewHref,
  orderReviewPages,
  reviewFinishSummary,
  reviewPageAt,
  reviewProgress,
} from "~/lib/dashboard/generation-review-model"
import { ReviewPageMarksProvider } from "~/lib/dashboard/review-page-marks-context"
import type { ReviewDecisionInput, ReviewDecisionResult } from "~/lib/dashboard/use-generation-review"
import { useReviewDecisions } from "~/lib/dashboard/use-review-decisions"
import { siteCanvasTheme } from "~/lib/dashboard/site-canvas"
import {
  focusedBranchHref,
  initialFocus,
  type ContentReviewSession,
} from "~/lib/dashboard/use-content-review"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function reviewPage(
  href: string,
  change: GenerationReviewPage["change"],
  decision: GenerationReviewPage["decision"],
): GenerationReviewPage {
  return { href, branchHref: href, title: href.slice(1), change, decision, reasons: [], decidedAt: null }
}

// Webhooks is the only page that a person decided on.
const pages = orderReviewPages([
  reviewPage("/install", "modified", "accepted"),
  { ...reviewPage("/webhooks", "added", "rejected"), decidedAt: "2026-10-14T10:00:00.000Z" },
  reviewPage("/pricing", "removed", "accepted"),
])

function session(focusHref: string, reviewPages: GenerationReviewPage[] = pages): ContentReviewSession {
  const review: GenerationReview = {
    id: "20000000-0000-4000-8000-000000000001",
    status: "open",
    jobId: "30000000-0000-4000-8000-000000000001",
    branch: {
      id: "10000000-0000-4000-8000-000000000001",
      name: "generation-review",
      baseVersionId: "40000000-0000-4000-8000-000000000001",
      revision: 3,
    },
    previewUrl: "https://acme--0123456789ab.doxa.page",
    createsBackup: false,
    backupBranchName: null,
    pages: reviewPages,
    ownedPageFlags: [],
    flaggedPages: [],
    pageNotices: [],
    createdAt: "2026-10-13T10:00:00.000Z",
    updatedAt: "2026-10-13T10:00:00.000Z",
  }
  return {
    review,
    branchId: review.branch?.id ?? "",
    pages: reviewPages,
    progress: reviewProgress(reviewPages),
    focusHref,
    focusedPage: reviewPageAt(reviewPages, focusHref),
    previousHref: adjacentReviewHref(reviewPages, focusHref, -1),
    nextHref: adjacentReviewHref(reviewPages, focusHref, 1),
    filter: "all",
  }
}

describe("review change list", () => {
  function renderList(props: Partial<Parameters<typeof ReviewChangeList>[0]> = {}) {
    const onSelect = vi.fn()
    const onShowAll = vi.fn()
    render(
      <ReviewChangeList
        pages={pages}
        filter="all"
        focusHref="/install"
        groupDecisions={null}
        onSelect={onSelect}
        onShowAll={onShowAll}
        {...props}
      />,
    )
    return { onSelect, onShowAll }
  }

  test("accepts or rejects every page of a group at once", () => {
    const onDecideAll = vi.fn(async () => true)
    renderList({ groupDecisions: { onDecideAll, disabled: false } })

    const deleted = screen.getByRole("region", { name: "Deleted pages" })
    fireEvent.click(within(deleted).getByRole("button", { name: "Delete all (deleted pages)" }))
    expect(onDecideAll).toHaveBeenCalledWith([pages.find((page) => page.href === "/pricing")], "accepted")

    const changed = screen.getByRole("region", { name: "Changed pages" })
    expect(within(changed).getByRole("button", { name: "Use all new versions (changed pages)" })).toBeTruthy()
    expect(within(changed).getByRole("button", { name: "Keep all current (changed pages)" })).toBeTruthy()

    // Every new page is already discarded, so only adding them changes anything.
    const added = screen.getByRole("region", { name: "New pages" })
    expect((within(added).getByRole("button", { name: "Discard all (new pages)" }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(added).getByRole("button", { name: "Add all (new pages)" }) as HTMLButtonElement).disabled).toBe(false)
  })

  test("shows no group buttons to a role that cannot decide, and disables them while a decision saves", () => {
    renderList()
    expect(screen.queryByRole("button", { name: /Delete all/ })).toBeNull()
    cleanup()

    renderList({ groupDecisions: { onDecideAll: vi.fn(async () => true), disabled: true } })
    expect((screen.getByRole("button", { name: "Delete all (deleted pages)" }) as HTMLButtonElement).disabled).toBe(true)
  })

  test("groups the pages by change, with the change on the left and the decision on the right", () => {
    const { onSelect } = renderList()

    const deleted = screen.getByRole("region", { name: "Deleted pages" })
    expect(within(deleted).getByText("pricing")).toBeTruthy()
    expect(within(deleted).getByRole("img", { name: "Deleted page" })).toBeTruthy()
    expect(within(deleted).getByRole("img", { name: "To review" })).toBeTruthy()
    expect(within(deleted).getByText("1 to review")).toBeTruthy()

    const added = screen.getByRole("region", { name: "New pages" })
    expect(within(added).getByRole("img", { name: "New page" })).toBeTruthy()
    expect(within(added).getByRole("img", { name: "Rejected" })).toBeTruthy()
    expect(within(added).getByText("All reviewed")).toBeTruthy()

    const focused = screen.getByRole("button", { name: /install/ })
    expect(focused.getAttribute("aria-current")).toBe("page")
    fireEvent.click(screen.getByRole("button", { name: /webhooks/ }))
    expect(onSelect).toHaveBeenCalledWith("/webhooks")
  })

  test("shows only the pages of one state, and every page again on request", () => {
    const { onShowAll } = renderList({ filter: "to_review" })

    expect(screen.queryByText("webhooks")).toBeNull()
    expect(screen.getByText("install")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Show all 3" }))
    expect(onShowAll).toHaveBeenCalled()
  })

  test("opens a page that a person moved at its branch href", () => {
    const moved = { ...reviewPage("/webhooks", "added", "accepted"), branchHref: "/hooks" }
    const { onSelect } = renderList({ pages: [moved], focusHref: "/hooks" })

    const row = screen.getByRole("button", { name: /webhooks/ })
    expect(row.getAttribute("aria-current")).toBe("page")
    fireEvent.click(row)
    expect(onSelect).toHaveBeenCalledWith("/hooks")
  })

  test("shows the path of pages that share a title", () => {
    const twins = [reviewPage("/aimemory", "added", "accepted"), { ...reviewPage("/", "removed", "pending"), title: "aimemory" }]
    renderList({ pages: twins, focusHref: null })
    expect(screen.getByText("/aimemory")).toBeTruthy()
    expect(screen.getByText("/")).toBeTruthy()
  })

  test("says when the generation changed no page", () => {
    renderList({ pages: [] })
    expect(screen.getByText("The generation changed no page.")).toBeTruthy()
  })
})

describe("page tree in a review", () => {
  const treePage: DocsContentPageDto = {
    href: "/install",
    title: "Install",
    status: "edited",
  } as DocsContentPageDto

  function renderRow(marks: readonly GenerationReviewPage[] | null) {
    const row = (
      <ContentPageRow
        page={treePage}
        isSelected={false}
        home={{ href: "/", pending: false }}
        onSelect={() => undefined}
        disabled={false}
      />
    )
    return render(marks ? <ReviewPageMarksProvider pages={marks}>{row}</ReviewPageMarksProvider> : row)
  }

  test("shows the change dot in place of the edited dot", () => {
    renderRow(pages)
    expect(screen.getByRole("img", { name: "Changed" })).toBeTruthy()
    expect(screen.queryByLabelText("Unpublished changes")).toBeNull()
  })

  test("keeps the change dot on a page that a person moved", () => {
    const moved = { ...reviewPage("/guide", "modified", "accepted"), branchHref: "/install" }
    renderRow([moved])
    expect(screen.getByRole("img", { name: "Changed" })).toBeTruthy()
  })

  test("keeps the edited dot outside a review", () => {
    renderRow(null)
    expect(screen.queryByRole("img", { name: "Changed" })).toBeNull()
    expect(screen.getByLabelText("Unpublished changes")).toBeTruthy()
  })

  test("sums the changes of a closed group in one mark", () => {
    render(<ReviewChangeCountDots counts={{ added: 2, modified: 0, removed: 1 }} />)
    const mark = screen.getByRole("img", { name: "2 new pages, 1 deleted page" })
    // One dot for each kind of change in the group.
    expect(mark.children).toHaveLength(2)
    cleanup()
    render(<ReviewChangeCountDots counts={{ added: 0, modified: 0, removed: 0 }} />)
    expect(screen.queryByRole("img")).toBeNull()
  })
})

describe("review diff pane", () => {
  function renderPane(
    focusHref: string,
    decision: Partial<ReviewDecisionControl> = {},
    onStep = vi.fn(),
    reviewPages: GenerationReviewPage[] = pages,
  ) {
    const onFinish = vi.fn()
    const current = session(focusHref, reviewPages)
    const page = current.focusedPage
    if (!page) throw new Error("The focus must be a review page.")
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    render(
      <ReviewDiffPane
        projectId="project-1"
        session={current}
        page={page}
        decision={{ canDecide: true, isSaving: false, disabled: false, onDecide: vi.fn(), ...decision }}
        canvas={{ theme: siteCanvasTheme(null), mode: "dark", onModeChange: () => undefined }}
        host="acme.doxa.page"
        liveDocsUrl="https://acme.doxa.page"
        onStep={onStep}
        onFinish={onFinish}
      />,
      { wrapper },
    )
    return { onStep, onFinish }
  }

  function stubSources(sources: GenerationReviewPageSources) {
    const fetchMock = vi.fn(async () => Response.json(sources))
    vi.stubGlobal("fetch", fetchMock)
    return fetchMock
  }

  test("shows the MDX change of a rewritten page like a pull request", async () => {
    const fetchMock = stubSources({
      href: "/install",
      published: "# Install\n\nRun the setup script.\n",
      generated: "# Install\n\nRun the bootstrap command.\n",
    })
    renderPane("/install")

    expect(screen.getByRole("region", { name: "Changes to install" })).toBeTruthy()
    expect(screen.getByText("2 / 3")).toBeTruthy()
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toContain("/generation-review/page?href=%2Finstall")

    await waitFor(() => {
      const diff = screen.getByLabelText("MDX changes of install")
      expect(diff.textContent).toContain("Run the bootstrap command.")
      // CodeMirror loads lazily, which is slow while the whole suite runs.
    }, { timeout: 5_000 })
    expect(screen.getByRole("radio", { name: "Side by side" })).toBeTruthy()
  })

  test("shows where a person moved the page, and where the generation put it", () => {
    const fetchMock = stubSources({ href: "/install", published: "# Old\n", generated: "# New\n" })
    const moved = pages.map((page) => (page.href === "/install" ? { ...page, branchHref: "/setup" } : page))
    renderPane("/setup", {}, vi.fn(), moved)

    expect(screen.getByText("/setup")).toBeTruthy()
    expect(screen.getByText("· from /install")).toBeTruthy()
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toContain("href=%2Finstall")
  })

  test("words the choices for the change, reject on the left and accept on the right", () => {
    stubSources({ href: "/install", published: "# Old\n", generated: "# New\n" })
    const onDecide = vi.fn()
    const { onStep } = renderPane("/install", { onDecide })

    expect(screen.getByText("The generation rewrote parts of this page. Compare the edits before deciding.")).toBeTruthy()
    const [reject, accept] = within(screen.getByRole("group", { name: "Decision for install" })).getAllByRole("button")
    expect(reject?.textContent).toContain("Keep current")
    expect(reject?.textContent).toContain("Reject the edits")
    expect(accept?.textContent).toContain("Use new version")
    fireEvent.click(accept as HTMLElement)
    expect(onDecide).toHaveBeenCalledWith("accepted")
    fireEvent.keyDown(window, { key: "r" })
    expect(onDecide).toHaveBeenCalledWith("rejected")

    fireEvent.click(screen.getByRole("button", { name: "Next page (J)" }))
    expect(onStep).toHaveBeenCalledWith("/webhooks")
    fireEvent.click(screen.getByRole("button", { name: "Previous page (K)" }))
    expect(onStep).toHaveBeenCalledWith("/pricing")
  })

  test("states a decision once made, with a way to change it and on to the next page", () => {
    stubSources({ href: "/webhooks", published: null, generated: "# Webhooks\n" })
    const onDecide = vi.fn()
    const { onStep } = renderPane("/webhooks", { onDecide })

    expect(screen.queryByRole("group", { name: "Decision for webhooks" })).toBeNull()
    const status = screen.getAllByRole("status").find((element) => element.textContent?.includes("Discarded"))
    expect(status?.textContent).toContain("Rejected")
    expect(status?.textContent).toContain("Discarded. It will not be published.")
    fireEvent.click(screen.getByRole("button", { name: "Change decision" }))
    expect(onDecide).toHaveBeenCalledWith("undecided")
    fireEvent.click(screen.getByRole("button", { name: "Next to review" }))
    expect(onStep).toHaveBeenCalledWith("/pricing")
  })

  test("offers to finish once no page waits", () => {
    stubSources({ href: "/webhooks", published: null, generated: "# Webhooks\n" })
    const done = pages.map((page) => ({ ...page, decision: "accepted" as const, decidedAt: "2026-10-14T10:00:00.000Z" }))
    const { onFinish } = renderPane("/webhooks", {}, vi.fn(), done)

    fireEvent.click(screen.getByRole("button", { name: "Finish review" }))
    expect(onFinish).toHaveBeenCalled()
  })

  test("offers only the live version of a removed page and hides decisions from readers", () => {
    stubSources({ href: "/pricing", published: "# Pricing\n", generated: null })
    renderPane("/pricing", { canDecide: false })

    expect(screen.getByRole("radio", { name: "Live" }).getAttribute("aria-checked")).toBe("true")
    expect((screen.getByRole("radio", { name: "Generated" }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole("radio", { name: "Side by side" })).toBeNull()
    expect(screen.queryByRole("group", { name: "Decision for pricing" })).toBeNull()
    expect((screen.getByRole("button", { name: "Previous page (K)" }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe("page off the review branch", () => {
  const deleted = { ...reviewPage("/pricing", "removed", "accepted"), decidedAt: "2026-10-14T10:00:00.000Z" }
  const discarded = { ...reviewPage("/webhooks", "added", "rejected"), decidedAt: "2026-10-14T10:00:00.000Z" }

  function renderNotice(page: GenerationReviewPage, restore: { onRestore: () => void } | null) {
    const onShowDiff = vi.fn()
    render(
      <ReviewAbsentPageNotice
        page={page}
        restore={restore ? { isRestoring: false, disabled: false, ...restore } : null}
        onShowDiff={onShowDiff}
      />,
    )
    return { onShowDiff }
  }

  test("says what the decision does and restores the page in place", () => {
    const onRestore = vi.fn()
    const { onShowDiff } = renderNotice(deleted, { onRestore })

    expect(screen.getByText("This page will be deleted")).toBeTruthy()
    expect(
      screen.getByText("It leaves your site when you publish. Restore it to keep and edit it."),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Restore page" }))
    expect(onRestore).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole("button", { name: "Show the diff" }))
    expect(onShowDiff).toHaveBeenCalledOnce()
  })

  test("words a discarded new page", () => {
    renderNotice(discarded, { onRestore: vi.fn() })

    expect(screen.getByText("This page is discarded")).toBeTruthy()
    expect(screen.getByText("It will not be published. Restore it to add and edit it.")).toBeTruthy()
  })

  test("offers no restore to a role that cannot decide", () => {
    renderNotice(deleted, null)

    expect(screen.queryByRole("button", { name: "Restore page" })).toBeNull()
    expect(screen.getByText("It leaves your site when you publish.")).toBeTruthy()
  })
})

describe("decision that removes a person's edits", () => {
  const added = reviewPage("/webhooks", "added", "accepted")

  function renderDecisions(results: ReviewDecisionResult[]) {
    const decide = vi.fn(async (_input: ReviewDecisionInput) => results.shift() ?? "saved")
    const focusOn = vi.fn()
    const hook = renderHook(() => useReviewDecisions(session("/webhooks").pages, { decide }, focusOn))
    return { decide, focusOn, hook }
  }

  test("waits for the person to confirm, then drops the edits", async () => {
    const { decide, hook } = renderDecisions(["edits_at_risk", "saved"])

    await act(async () => {
      expect(await hook.result.current.decide(added, "rejected")).toBe(false)
    })
    expect(hook.result.current.editsAtRisk).toMatchObject({ entries: [{ page: added, decision: "rejected" }] })

    await act(async () => hook.result.current.confirmEditsAtRisk())
    expect(decide).toHaveBeenLastCalledWith({
      decisions: [{ href: "/webhooks", decision: "rejected" }],
      discardEdits: true,
    })
    expect(hook.result.current.editsAtRisk).toBeNull()
  })

  test("decides on a whole group in one save, skips the pages that hold the decision, and keeps the focus", async () => {
    const { decide, focusOn, hook } = renderDecisions(["edits_at_risk", "saved"])
    const group = [
      reviewPage("/a", "added", "accepted"),
      { ...reviewPage("/b", "added", "rejected"), decidedAt: "2026-10-14T10:00:00.000Z" },
      reviewPage("/c", "added", "accepted"),
    ]

    await act(async () => {
      expect(await hook.result.current.decideAll(group, "rejected")).toBe(false)
    })
    expect(decide).toHaveBeenLastCalledWith({
      decisions: [
        { href: "/a", decision: "rejected" },
        { href: "/c", decision: "rejected" },
      ],
      discardEdits: false,
    })
    expect(hook.result.current.editsAtRisk?.entries).toHaveLength(2)

    await act(async () => hook.result.current.confirmEditsAtRisk())
    expect(decide).toHaveBeenLastCalledWith(expect.objectContaining({ discardEdits: true }))
    expect(focusOn).not.toHaveBeenCalled()
  })

  test("keeps the page and its edits on cancel", async () => {
    const { decide, hook } = renderDecisions(["edits_at_risk"])

    await act(async () => void (await hook.result.current.decide(added, "rejected")))
    act(() => hook.result.current.cancelEditsAtRisk())

    expect(hook.result.current.editsAtRisk).toBeNull()
    expect(decide).toHaveBeenCalledOnce()
  })

  test("words the question for the change", () => {
    const onConfirm = vi.fn()
    const deleted = reviewPage("/pricing", "removed", "pending")
    render(
      <ReviewEditsDialog
        pending={{ entries: [{ page: deleted, decision: "accepted" }], options: {} }}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByText("Delete this page and your edits?")).toBeTruthy()
    expect(screen.getByText("You edited this page. Deleting it also removes your edits.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Delete page" }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  test("words the question for a group", () => {
    const entries = ["/a", "/b"].map((href) => ({ page: reviewPage(href, "added", "accepted"), decision: "rejected" as const }))
    render(<ReviewEditsDialog pending={{ entries, options: {} }} onConfirm={vi.fn()} onCancel={vi.fn()} />)

    expect(screen.getByText("Discard these pages and your edits?")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Discard pages" })).toBeTruthy()
  })
})

describe("review focus", () => {
  const moved = (branchHref: string) =>
    pages.map((page) => (page.href === "/install" ? { ...page, branchHref } : page))

  test("opens the page in the URL, else the first review page", () => {
    expect(initialFocus("review-1", pages, "/install")).toEqual({
      reviewId: "review-1",
      href: "/install",
      reviewHref: "/install",
    })
    expect(initialFocus("review-1", pages, "/unknown").reviewHref).toBe(pages[0]?.href)
  })

  test("follows a review page that a person renames", () => {
    const focus = initialFocus("review-1", pages, "/install")
    expect(focusedBranchHref(focus, moved("/setup"))).toBe("/setup")
  })

  test("stays on its page when a decision reorders the list", () => {
    const focus = initialFocus("review-1", pages, "/install")
    expect(focusedBranchHref(focus, [...pages].reverse())).toBe("/install")
  })

  test("keeps a page outside the review where it is", () => {
    expect(focusedBranchHref({ reviewId: "review-1", href: "/owned", reviewHref: null }, pages)).toBe("/owned")
  })
})

describe("finish review", () => {
  function renderDialog(reviewPages: GenerationReviewPage[]) {
    const onPublish = vi.fn()
    const onReviewRemaining = vi.fn()
    render(
      <ReviewFinishDialog
        open
        onOpenChange={() => undefined}
        summary={reviewFinishSummary(reviewPages)}
        createsBackup
        isPublishing={false}
        error={null}
        onPublish={onPublish}
        onReviewRemaining={onReviewRemaining}
      />,
    )
    return { onPublish, onReviewRemaining }
  }

  test("publishes the generation's changes without a decision on each page", () => {
    const { onPublish, onReviewRemaining } = renderDialog(pages)

    expect(screen.getByText("Goes live · 2")).toBeTruthy()
    expect(screen.getByText("1 page deleted")).toBeTruthy()
    expect(screen.getByText("2 changes are not reviewed yet")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Review remaining" }))
    expect(onReviewRemaining).toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Publish 2 changes" }))
    expect(onPublish).toHaveBeenCalled()
  })

  test("sums up what goes live and publishes it", () => {
    const decided = pages.map((page) =>
      page.change === "removed" ? { ...page, decision: "rejected" as const, decidedAt: "2026-10-14T10:00:00.000Z" } : page,
    )
    const { onPublish } = renderDialog(decided)

    expect(screen.getByText("Goes live · 1")).toBeTruthy()
    expect(screen.getByText("1 page updated")).toBeTruthy()
    expect(screen.getByText("Discarded · 2")).toBeTruthy()
    expect(screen.getByText("1 change is not reviewed yet")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Publish 1 change" }))
    expect(onPublish).toHaveBeenCalled()
  })
})
