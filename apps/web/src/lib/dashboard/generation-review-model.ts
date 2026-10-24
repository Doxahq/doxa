import type {
  GenerationReviewDecision,
  GenerationReviewPage,
  GenerationReviewPageChange,
} from "@doxahq/contracts/generation-reviews"

/** The color family of a change mark. */
export type ReviewChangeTone = "success" | "warning" | "danger"

/** How each change reads in the review: its name, what it does and its color. */
export const REVIEW_CHANGE_MARK: Record<
  GenerationReviewPageChange,
  { label: string; description: string; tone: ReviewChangeTone }
> = {
  added: { label: "New", description: "The generation wrote this page.", tone: "success" },
  modified: { label: "Changed", description: "The generation rewrote this page.", tone: "warning" },
  removed: { label: "Deleted", description: "The generation removed this page.", tone: "danger" },
}

/** How many pages of a part of the tree each kind of change touches. */
export type ReviewChangeCounts = Record<GenerationReviewPageChange, number>

/** The changes in order of the dots: new, changed, deleted. */
export const REVIEW_CHANGES: readonly GenerationReviewPageChange[] = ["added", "modified", "removed"]

/** Counts the changes of the review pages among `hrefs`. */
export function countReviewChanges(
  marks: ReadonlyMap<string, GenerationReviewPage>,
  hrefs: readonly string[],
): ReviewChangeCounts {
  const counts: ReviewChangeCounts = { added: 0, modified: 0, removed: 0 }
  for (const href of hrefs) {
    const page = marks.get(href)
    if (page) counts[page.change] += 1
  }
  return counts
}

/** The counts in words, for example "2 new pages, 1 removed page". Empty when there is no change. */
export function describeReviewChanges(counts: ReviewChangeCounts): string {
  return REVIEW_CHANGES.filter((change) => counts[change] > 0)
    .map((change) => {
      const count = counts[change]
      return `${count} ${REVIEW_CHANGE_MARK[change].label.toLowerCase()} ${count === 1 ? "page" : "pages"}`
    })
    .join(", ")
}

/** One of the two choices of a page, worded for what it does to the page. */
export interface ReviewChoice {
  /** The button label, for example "Delete page". */
  label: string
  /** The line under the label, for example "Accept the deletion". */
  caption: string
  /** What happens once the person chose it, for example "Will be deleted when you publish." */
  outcome: string
  /** The label of the same choice for every page of a sidebar group, for example "Delete all". */
  allLabel: string
}

/** How a review page reads, by what the generation did to it. */
export interface ReviewChangeCopy {
  /** The tag of the change, as the sidebar group and the page header show it. */
  tag: string
  /** One sentence that explains the change above the decision. */
  sentence: string
  /** Rejecting keeps the live site as it is. */
  reject: ReviewChoice
  /** Accepting takes the change of the generation. */
  accept: ReviewChoice
}

export const REVIEW_CHANGE_COPY: Record<GenerationReviewPageChange, ReviewChangeCopy> = {
  removed: {
    tag: "Deleted",
    sentence: "The generation removed this page. It stays on your live site until you publish.",
    reject: {
      label: "Keep page",
      caption: "Reject the deletion",
      outcome: "Stays on your site, unchanged.",
      allLabel: "Keep all",
    },
    accept: {
      label: "Delete page",
      caption: "Accept the deletion",
      outcome: "Will be deleted when you publish.",
      allLabel: "Delete all",
    },
  },
  modified: {
    tag: "Changed",
    sentence: "The generation rewrote parts of this page. Compare the edits before deciding.",
    reject: {
      label: "Keep current",
      caption: "Reject the edits",
      outcome: "Current version stays. Edits are dropped.",
      allLabel: "Keep all current",
    },
    accept: {
      label: "Use new version",
      caption: "Accept the edits",
      outcome: "New version goes live when you publish.",
      allLabel: "Use all new versions",
    },
  },
  added: {
    tag: "New",
    sentence: "The generation wrote this page. It is not on your live site yet.",
    reject: {
      label: "Discard page",
      caption: "Reject the new page",
      outcome: "Discarded. It will not be published.",
      allLabel: "Discard all",
    },
    accept: {
      label: "Add page",
      caption: "Accept the new page",
      outcome: "Will be added when you publish.",
      allLabel: "Add all",
    },
  },
}

/** The order of the sidebar groups and of the review: deleted, changed, new. */
export const REVIEW_GROUP_ORDER: readonly GenerationReviewPageChange[] = ["removed", "modified", "added"]

/**
 * Where a page is in the review. A page is to review until a person decides
 * on it, even when it starts with a decision, such as a new page that is
 * accepted unless the person discards it.
 */
export type ReviewState = "to_review" | "accepted" | "rejected"

export const REVIEW_STATE_LABEL: Record<ReviewState, string> = {
  to_review: "To review",
  accepted: "Accepted",
  rejected: "Rejected",
}

export function reviewState(page: GenerationReviewPage): ReviewState {
  if (page.decidedAt === null) return "to_review"
  return page.decision === "accepted" ? "accepted" : "rejected"
}

/** The choice that a decided page holds, with its wording. */
export function reviewChoice(page: GenerationReviewPage, state: Exclude<ReviewState, "to_review">): ReviewChoice {
  const copy = REVIEW_CHANGE_COPY[page.change]
  return state === "accepted" ? copy.accept : copy.reject
}

/** The pages that the sidebar shows: every page, or the pages in one state. */
export type ReviewFilter = "all" | ReviewState

export function filterReviewPages(
  pages: readonly GenerationReviewPage[],
  filter: ReviewFilter,
): GenerationReviewPage[] {
  return filter === "all" ? [...pages] : pages.filter((page) => reviewState(page) === filter)
}

/**
 * True when the decision keeps the page on the review branch, so the editor
 * can open it there: a new page that the person adds, any rewritten page,
 * and a removal that the person has not accepted.
 */
export function isOnReviewBranch(page: GenerationReviewPage): boolean {
  if (page.change === "added") return page.decision === "accepted"
  if (page.change === "removed") return page.decision !== "accepted"
  return true
}

/**
 * The decision that puts a page that is off the review branch back on it:
 * keep a removed page, add a new page. A rewritten page is never off it.
 */
export function restoringDecision(page: GenerationReviewPage): GenerationReviewDecision {
  return page.change === "added" ? "accepted" : "rejected"
}

/** The evidence that a review row shows under the page. */
export interface ReviewPageEvidence {
  /** The source files that the writer read. */
  sources: string[]
  /** Statements of the hand-written page that the source contradicts. */
  conflicts: string[]
}

export function reviewPageEvidence(page: Pick<GenerationReviewPage, "reasons">): ReviewPageEvidence {
  return page.reasons.reduce<ReviewPageEvidence>(
    (evidence, reason) => {
      switch (reason.kind) {
        case "based_on_sources":
          return { ...evidence, sources: [...evidence.sources, ...reason.paths] }
        case "seed_conflicts":
          return { ...evidence, conflicts: [...evidence.conflicts, ...reason.items] }
        default:
          return evidence
      }
    },
    { sources: [], conflicts: [] },
  )
}

/** The pages of one kind of change, as one sidebar group. */
export interface ReviewChangeGroup {
  change: GenerationReviewPageChange
  pages: GenerationReviewPage[]
  /** The pages of the group that wait for a person, whatever the filter shows. */
  toReview: number
  total: number
}

/** The sidebar groups, in review order. `shown` are the pages that the filter keeps. */
export function groupReviewPagesByChange(
  pages: readonly GenerationReviewPage[],
  shown: readonly GenerationReviewPage[] = pages,
): ReviewChangeGroup[] {
  return REVIEW_GROUP_ORDER.map((change) => {
    const all = pages.filter((page) => page.change === change)
    return {
      change,
      pages: shown.filter((page) => page.change === change),
      toReview: all.filter((page) => reviewState(page) === "to_review").length,
      total: all.length,
    }
  })
}

/** The titles that more than one review page has, so their rows show the path too. */
export function duplicateReviewTitles(pages: readonly GenerationReviewPage[]): Set<string> {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const page of pages) {
    if (seen.has(page.title)) duplicates.add(page.title)
    seen.add(page.title)
  }
  return duplicates
}

/**
 * The pages in the order a person reviews them: deleted, changed, then new
 * pages, each by path, like the files of a pull request. The order does not
 * depend on the decisions, so a page keeps its place after one.
 */
export function orderReviewPages(pages: readonly GenerationReviewPage[]): GenerationReviewPage[] {
  const byPath = [...pages].sort((left, right) => left.href.localeCompare(right.href))
  return REVIEW_GROUP_ORDER.flatMap((change) => byPath.filter((page) => page.change === change))
}

/** How far the person is through the review. */
export interface ReviewProgress {
  total: number
  /** Pages that a person has decided on. */
  reviewed: number
  toReview: number
  accepted: number
  rejected: number
}

export function reviewProgress(pages: readonly GenerationReviewPage[]): ReviewProgress {
  const count = (state: ReviewState) => pages.filter((page) => reviewState(page) === state).length
  const accepted = count("accepted")
  const rejected = count("rejected")
  return { total: pages.length, reviewed: accepted + rejected, toReview: count("to_review"), accepted, rejected }
}

/**
 * What finishing the review publishes. Every page counts with the decision
 * it holds now, decided by a person or not. A removal that waits for a
 * decision blocks the publish.
 */
export interface ReviewFinishSummary {
  added: number
  updated: number
  deleted: number
  /** The changes that go live. */
  live: number
  /** The changes that are dropped. */
  discarded: number
  /** Pages that no person decided on yet. They are published as the review shows them. */
  toReview: number
}

export function reviewFinishSummary(pages: readonly GenerationReviewPage[]): ReviewFinishSummary {
  const accepted = (change: GenerationReviewPageChange) =>
    pages.filter((page) => page.change === change && page.decision === "accepted").length
  const added = accepted("added")
  const updated = accepted("modified")
  const deleted = accepted("removed")
  return {
    added,
    updated,
    deleted,
    live: added + updated + deleted,
    discarded: pages.filter((page) => page.decision === "rejected").length,
    toReview: pages.filter((page) => reviewState(page) === "to_review").length,
  }
}

/**
 * The branch href of the next page to review after `branchHref`, in review
 * order, from the start again at the end. Null when no other page waits.
 */
export function nextToReviewHref(
  ordered: readonly GenerationReviewPage[],
  branchHref: string | null,
): string | null {
  const index = ordered.findIndex((page) => page.branchHref === branchHref)
  for (let step = 1; step <= ordered.length; step += 1) {
    const page = ordered[(index + step) % ordered.length]
    if (page && page.branchHref !== branchHref && reviewState(page) === "to_review") return page.branchHref
  }
  return null
}

/** The review page at a branch href: where the page is in the editor, after any move. */
export function reviewPageAt(
  pages: readonly GenerationReviewPage[],
  branchHref: string | null,
): GenerationReviewPage | null {
  return pages.find((page) => page.branchHref === branchHref) ?? null
}

/**
 * The branch href of the page before or after `branchHref` in review order.
 * A page outside the review steps to the first or the last page. There is
 * no step past either end.
 */
export function adjacentReviewHref(
  ordered: readonly GenerationReviewPage[],
  branchHref: string | null,
  step: 1 | -1,
): string | null {
  if (ordered.length === 0) return null
  const index = ordered.findIndex((page) => page.branchHref === branchHref)
  if (index === -1) return (step === 1 ? ordered[0] : ordered[ordered.length - 1]).branchHref
  return ordered[index + step]?.branchHref ?? null
}
