import type { FlaggedPage, FlaggedPageOutcome } from "@doxahq/contracts/generation-reviews"

/** What the version shows in place of a page the run could not write. */
export const FLAGGED_PAGE_OUTCOME_LABEL: Record<FlaggedPageOutcome, string> = {
  kept_published: "Kept the published page",
  left_out: "Not in this version",
}

export function flaggedPagesHeading(count: number): string {
  return count === 1 ? "1 page could not be written" : `${count} pages could not be written`
}

/** An older API sends no flagged pages; that reads as none. */
export function readFlaggedPages(source: { flaggedPages?: readonly FlaggedPage[] }): readonly FlaggedPage[] {
  return source.flaggedPages ?? []
}
