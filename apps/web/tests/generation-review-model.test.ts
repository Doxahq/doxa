import { describe, expect, test } from "vitest"
import type { GenerationReviewPage } from "@doxahq/contracts/generation-reviews"

import {
  adjacentReviewHref,
  countReviewChanges,
  describeReviewChanges,
  duplicateReviewTitles,
  filterReviewPages,
  groupReviewPagesByChange,
  isOnReviewBranch,
  nextToReviewHref,
  orderReviewPages,
  reviewFinishSummary,
  reviewPageEvidence,
  reviewPageAt,
  reviewProgress,
  restoringDecision,
  reviewState,
} from "~/lib/dashboard/generation-review-model"

function page(
  href: string,
  change: GenerationReviewPage["change"],
  decision: GenerationReviewPage["decision"],
  branchHref = href,
): GenerationReviewPage {
  return { href, branchHref, title: href, change, decision, reasons: [], decidedAt: null }
}

/** A page that a person decided on. */
function decided(entry: GenerationReviewPage): GenerationReviewPage {
  return { ...entry, decidedAt: "2026-10-14T10:00:00.000Z" }
}

// The new, the changed and the removed page start accepted, but nobody decided on them yet.
const pages = [
  page("/install", "modified", "accepted"),
  page("/webhooks", "added", "accepted"),
  decided(page("/legacy", "added", "rejected")),
  page("/pricing", "removed", "accepted"),
  decided(page("/faq", "removed", "accepted")),
]

describe("generation review model", () => {
  test("keeps a page to review until a person decides on it", () => {
    expect(pages.map(reviewState)).toEqual(["to_review", "to_review", "rejected", "to_review", "accepted"])
  })

  test("sums up what finishing the review publishes, undecided pages included", () => {
    expect(reviewFinishSummary(pages)).toEqual({
      added: 1,
      updated: 1,
      deleted: 2,
      live: 4,
      discarded: 1,
      toReview: 3,
    })
  })

  test("groups the pages by change and filters them by state", () => {
    const shown = filterReviewPages(pages, "to_review")
    const groups = groupReviewPagesByChange(pages, shown)

    expect(groups.map((group) => [group.change, group.pages.map((entry) => entry.href), group.toReview, group.total])).toEqual([
      ["removed", ["/pricing"], 1, 2],
      ["modified", ["/install"], 1, 1],
      ["added", ["/webhooks"], 1, 2],
    ])
    expect(filterReviewPages(pages, "all")).toHaveLength(5)
  })

  test("names the titles that more than one page has", () => {
    const twins = [page("/aimemory", "added", "accepted"), { ...page("/", "removed", "pending"), title: "/aimemory" }]
    expect([...duplicateReviewTitles(twins)]).toEqual(["/aimemory"])
    expect(duplicateReviewTitles(pages).size).toBe(0)
  })

  test("finds the next page to review, from the start again at the end", () => {
    const ordered = orderReviewPages(pages)

    expect(nextToReviewHref(ordered, "/faq")).toBe("/pricing")
    expect(nextToReviewHref(ordered, "/webhooks")).toBe("/pricing")
    expect(nextToReviewHref(ordered, null)).toBe("/pricing")
    expect(nextToReviewHref([decided(page("/a", "added", "accepted"))], "/a")).toBeNull()
  })

  test("reads citations and conflicts from the reasons", () => {
    const seeded: GenerationReviewPage = {
      ...page("/install", "modified", "accepted"),
      reasons: [
        { kind: "content_rewritten" },
        { kind: "seed_conflicts", items: ["Uses make -> uses pnpm (Makefile)"] },
        { kind: "based_on_sources", paths: ["src/install.ts"] },
      ],
    }
    expect(reviewPageEvidence(seeded)).toEqual({
      sources: ["src/install.ts"],
      conflicts: ["Uses make -> uses pnpm (Makefile)"],
    })
  })

  test("orders the review by change, deleted then changed then new, each by path", () => {
    expect(orderReviewPages(pages).map((entry) => entry.href)).toEqual([
      "/faq",
      "/pricing",
      "/install",
      "/legacy",
      "/webhooks",
    ])
  })

  test("keeps the place of a page after a decision", () => {
    const decided = pages.map((entry) => (entry.href === "/install" ? { ...entry, decision: "rejected" as const } : entry))
    const moved = [...decided.filter((entry) => entry.href !== "/install"), decided[0]]
    expect(orderReviewPages(moved).map((entry) => entry.href)).toEqual(
      orderReviewPages(pages).map((entry) => entry.href),
    )
  })

  test("counts the progress of the review", () => {
    expect(reviewProgress(pages)).toEqual({ total: 5, reviewed: 2, toReview: 3, accepted: 1, rejected: 1 })
    expect(reviewProgress([])).toEqual({ total: 0, reviewed: 0, toReview: 0, accepted: 0, rejected: 0 })
  })

  test("steps through the review and stops at both ends", () => {
    const ordered = orderReviewPages(pages)

    expect(adjacentReviewHref(ordered, "/install", 1)).toBe("/legacy")
    expect(adjacentReviewHref(ordered, "/pricing", -1)).toBe("/faq")
    expect(adjacentReviewHref(ordered, "/faq", -1)).toBeNull()
    expect(adjacentReviewHref(ordered, "/webhooks", 1)).toBeNull()
  })

  test("steps from a page outside the review to the first or the last page", () => {
    const ordered = orderReviewPages(pages)

    expect(adjacentReviewHref(ordered, "/unchanged", 1)).toBe("/faq")
    expect(adjacentReviewHref(ordered, null, -1)).toBe("/webhooks")
    expect(adjacentReviewHref([], "/install", 1)).toBeNull()
  })

  test("finds and steps through a page where a person moved it", () => {
    const moved = orderReviewPages([
      page("/install", "modified", "accepted"),
      page("/webhooks", "added", "accepted", "/hooks"),
    ])

    expect(reviewPageAt(moved, "/hooks")?.href).toBe("/webhooks")
    expect(reviewPageAt(moved, "/webhooks")).toBeNull()
    expect(adjacentReviewHref(moved, "/install", 1)).toBe("/hooks")
    expect(adjacentReviewHref(moved, "/hooks", -1)).toBe("/install")
  })

  test("keeps a page on the review branch by its decision alone", () => {
    expect(isOnReviewBranch(page("/a", "added", "accepted"))).toBe(true)
    expect(isOnReviewBranch(page("/a", "added", "rejected"))).toBe(false)
    expect(isOnReviewBranch(page("/a", "modified", "rejected"))).toBe(true)
    expect(isOnReviewBranch(page("/a", "removed", "rejected"))).toBe(true)
    // Only an older review stores a pending removal, and its branch keeps the page.
    expect(isOnReviewBranch(page("/a", "removed", "pending"))).toBe(true)
    expect(isOnReviewBranch(page("/a", "removed", "accepted"))).toBe(false)
    // A rename changes where the page is, not whether the branch has it.
    expect(isOnReviewBranch(page("/a", "added", "accepted", "/b"))).toBe(true)
  })

  test("restores a page that a decision took off the review branch", () => {
    for (const offBranch of [page("/a", "added", "rejected"), page("/a", "removed", "accepted")]) {
      expect(isOnReviewBranch({ ...offBranch, decision: restoringDecision(offBranch) })).toBe(true)
    }
  })

  test("counts the changes in a part of the tree and words them", () => {
    const marks = new Map(pages.map((entry) => [entry.href, entry]))
    const counts = countReviewChanges(marks, ["/webhooks", "/legacy", "/faq", "/unchanged"])
    expect(counts).toEqual({ added: 2, modified: 0, removed: 1 })
    expect(describeReviewChanges(counts)).toBe("2 new pages, 1 deleted page")
    expect(describeReviewChanges(countReviewChanges(marks, ["/unchanged"]))).toBe("")
  })
})
