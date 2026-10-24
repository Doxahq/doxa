// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import type { GenerationChangedPage } from "@doxahq/contracts/generation-reviews"
import { afterEach, describe, expect, test, vi } from "vitest"

import { ReviewChangeList } from "~/components/dashboard/content/review/review-change-list"
import { ReviewReadOnlyBar } from "~/components/dashboard/content/review/review-decision-bar"
import {
  CHANGED_PAGE_SENTENCE,
  countChangedPages,
  toChangesViewPages,
} from "~/lib/dashboard/generation-changes-model"
import { adjacentReviewHref } from "~/lib/dashboard/generation-review-model"
import { hasReadableChanges } from "~/lib/dashboard/generation-model"
import { sidebarViewForPath } from "~/lib/dashboard/shell-context"

afterEach(cleanup)

function changed(href: string, change: GenerationChangedPage["change"]): GenerationChangedPage {
  return { href, title: href.slice(1), change, reasons: [] }
}

const changedPages = [
  changed("/webhooks", "added"),
  changed("/legacy", "removed"),
  changed("/install", "modified"),
  changed("/audit", "added"),
]

describe("changes of a pull request preview", () => {
  test("reads the changed pages as review pages that nobody decided on, in review order", () => {
    const pages = toChangesViewPages(changedPages)

    expect(pages.map((page) => page.href)).toEqual(["/legacy", "/install", "/audit", "/webhooks"])
    expect(pages.every((page) => page.branchHref === page.href && page.decidedAt === null)).toBe(true)
    expect(countChangedPages(changedPages)).toEqual({ added: 2, modified: 1, removed: 1 })
  })

  test("lists the pages by change, without decisions or what is left to review", () => {
    const onSelect = vi.fn()
    render(
      <ReviewChangeList
        pages={toChangesViewPages(changedPages)}
        filter="all"
        focusHref="/install"
        groupDecisions={null}
        readOnly
        onSelect={onSelect}
        onShowAll={() => undefined}
      />,
    )

    const added = screen.getByRole("region", { name: "New pages" })
    expect(within(added).getByText("webhooks")).toBeTruthy()
    expect(screen.queryByText(/to review/)).toBeNull()
    expect(screen.queryByRole("img", { name: "To review" })).toBeNull()
    expect(screen.getByRole("button", { name: /install/ }).getAttribute("aria-current")).toBe("page")
    fireEvent.click(screen.getByRole("button", { name: /legacy/ }))
    expect(onSelect).toHaveBeenCalledWith("/legacy")
  })

  test("shows the page and the way through the pages, with no decision to make", () => {
    const pages = toChangesViewPages(changedPages)
    const onStep = vi.fn()
    const page = pages[1]
    render(
      <ReviewReadOnlyBar
        page={page}
        sentence={CHANGED_PAGE_SENTENCE[page.change]}
        steps={{
          pages,
          previousHref: adjacentReviewHref(pages, page.href, -1),
          nextHref: adjacentReviewHref(pages, page.href, 1),
        }}
        onStep={onStep}
      />,
    )

    expect(screen.getByText(CHANGED_PAGE_SENTENCE.modified)).toBeTruthy()
    expect(screen.getByText("2 / 4")).toBeTruthy()
    expect(screen.queryByRole("group", { name: /Decision for/ })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Next page (J)" }))
    expect(onStep).toHaveBeenCalledWith("/audit")
  })

  test("opens the changes from a succeeded pull request preview only", () => {
    const preview = {
      status: "succeeded" as const,
      deployment: { environment: "preview" as const, docsVersionId: "version-1" },
    }
    expect(hasReadableChanges(preview)).toBe(true)
    expect(hasReadableChanges({ ...preview, status: "failed" as const })).toBe(false)
    expect(hasReadableChanges({ ...preview, deployment: { ...preview.deployment, environment: "production" as const } })).toBe(false)
    expect(hasReadableChanges({ ...preview, deployment: { ...preview.deployment, docsVersionId: null } })).toBe(false)
  })

  test("lists the changed pages in the sidebar's Content view", () => {
    expect(sidebarViewForPath("/dashboard/projects/p1/generations/g1/changes")).toBe("content")
    expect(sidebarViewForPath("/dashboard/projects/p1/generations/g1")).toBe("project")
  })
})
